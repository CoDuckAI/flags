# CoDuck Flags — Phase 0 Spec (OSS MVP)

> **Status:** draft · **Scope:** standalone open-source core, zero CoDuck infra required
> **Package family:** `@coduck/flags` · **License:** MIT · **Repo:** `CoDuckAI/flags`

Phase 0 is the open-source portfolio artifact: a fast, correct feature-flag SDK that a
developer can `npm i` and use with **no backend at all**, and that can flip a feature on/off
**live in under a second, no restart**, when pointed at the (also OSS) reference server.
Everything CoDuck-specific (dashboard, auth/billing targeting, Signals experiments,
multi-tenant control plane) is **Phase 1+** and deliberately out of scope here.

The definition of "done" is a working demo: `coduck-flags serve` → an app using the SDK →
`coduck-flags off new-checkout` in another terminal → the feature is off in the running app
within ~1s, the process never restarted, and if the server is killed the app keeps serving
its last-known-good values instead of crashing.

---

## 1. Goals & non-goals

### In scope (Phase 0)
1. **Evaluation engine** — pure, isomorphic, zero-dep. Boolean + multivariate flags, ordered
   rules, reusable segments, individual targeting, deterministic percentage rollouts. *The
   crown jewel.*
2. **Ruleset schema** — the flags-as-code JSON format (JSON Schema published + validated).
3. **Node/edge server SDK** (`@coduck/flags`) — local in-memory eval; source = a committed
   JSON file **or** the reference server over HTTP; polling + SSE refresh; fail-static
   defaults; never throws.
4. **Reference server** (`@coduck/flags-server`) — serves ruleset snapshots over HTTP, streams
   live updates over SSE, single-process, file/SQLite-backed. **No Postgres/Redis** — keeps
   the "clone and run anywhere" promise.
5. **CLI** (`coduck-flags`) — scaffold, validate, toggle, roll out, run the server, dry-run
   eval.
6. **OpenFeature provider** (`@coduck/flags-openfeature`) — the SDK behind the CNCF-standard
   vendor-neutral interface. Interop + credibility.
7. **Quality artifacts** — golden bucketing test vectors, property/fuzz tests, a published
   throughput benchmark, docs site, and a README with a 30-second quickstart.

### Explicitly deferred (NOT Phase 0)
- Multi-tenant control plane, hosted dashboard UI, RBAC, audit log → **Phase 1 (CoDuck-managed)**
- CoDuck auth / plan-tier / Signals integration → **Phase 1**
- Browser client SDK + React hooks + Next.js server-eval helpers → **Phase 0.5 / Phase 3**
  (the *pattern* is specified below so the engine doesn't need changes later)
- A/B experiment assignment + stats engine → **Phase 2**
- Non-JS language SDKs → later (but golden vectors are shipped now so parity is provable)

---

## 2. Security invariants (non-negotiable, baked in from line one)

These are design commitments, not features. Every part of Phase 0 must uphold them, and they
go in the README as loudly as the quickstart.

1. **Flags are NOT an authorization boundary.** A flag controls *visibility and rollout*, not
   *access*. If a paid/gated capability sits behind a flag, the **server must still enforce
   the entitlement independently**. The docs state this in the first section and every
   "paid users only" example carries the warning. `isEnabled` is for "should I show/ship
   this," never "is this user allowed."
2. **Never trust client-supplied entitlement context.** Attributes that decide access
   (`plan`, `tier`, `userId`) must be derived from an authenticated server-side session, never
   accepted from the browser. Phase 0 is server-side only, which makes this automatic — but
   it's documented now so the Phase 0.5 browser SDK can't regress it.
3. **Never ship the ruleset to the browser.** The full ruleset leaks unreleased-feature names,
   targeting rules, and segment definitions. The browser story (Phase 0.5) is
   **server-evaluated results only** — the client receives its own evaluated values, nothing
   else. The engine already supports this via `allFlags(context)`.
4. **The SDK can never throw and never blocks the app.** Every eval takes a caller default.
   Any error — unreachable source, missing flag, malformed rule, missing bucketing key —
   returns the default with a `reason`, and (optionally) fires `onError`. A flag system must
   not be able to take down its host.
5. **Fail-static.** The SDK boots from a last-known-good ruleset (bootstrap value or on-disk
   cache) so a cold/unreachable server doesn't block startup or flip everyone to defaults.
6. **Two key scopes even in the reference server.** A read/SDK key can fetch a ruleset; write
   operations (toggle/rollout) require a separate admin key. No single key both reads flags
   and mutates them.
7. **Delivery is authenticated + TLS.** The HTTP/SSE source requires the SDK key and must run
   over TLS in any real deployment; snapshots carry a version + `updatedAt` so tampering and
   staleness are detectable.
8. **Deterministic, specified bucketing.** The hash and bucket math are pinned exactly (§6)
   and covered by golden vectors, so rollouts are reproducible and future language SDKs bucket
   identically.

---

## 3. Architecture & repo layout

Monorepo (pnpm workspaces). Small packages, one job each, so the engine stays dependency-free
and reusable.

```
flags/  (CoDuckAI/flags)
├─ packages/
│  ├─ core/         → @coduck/flags-core        eval engine + schema + bucketing (0 deps, isomorphic)
│  ├─ sdk-node/     → @coduck/flags             the server SDK devs install (wraps core)
│  ├─ openfeature/  → @coduck/flags-openfeature  OpenFeature provider (wraps sdk-node)
│  ├─ server/       → @coduck/flags-server       reference server (HTTP + SSE, file/SQLite)
│  ├─ cli/          → @coduck/flags-cli          bin: `coduck-flags`
│  └─ test-vectors/ → @coduck/flags-test-vectors golden JSON: bucketing + eval cases
├─ examples/        → express-app, next-app (server-eval bootstrap), edge-worker
├─ docs/            → docs site (quickstart, schema, security, benchmarks)
└─ .github/         → CI: test + typecheck + benchmark + OpenFeature compat suite
```

**Data flow (with reference server):**

```
flags.json / SQLite ──load──▶ [reference server] ──HTTP snapshot──▶ [SDK: in-memory ruleset]
      ▲                              │                                      │
   CLI writes                    SSE stream ──push on change──────────────▶ atomic swap
   (toggle/rollout)                                                         │
                                                                    isEnabled() = RAM read
```

**Data flow (zero backend):** SDK loads `flags.json` directly (file source), optionally
watches it for changes. Works offline, in CI, in tests.

The read path (`isEnabled`) is always a pure in-memory read — it never touches the file,
server, or any DB. The source only refreshes the ruleset in the background.

---

## 4. Ruleset schema (flags-as-code)

One JSON document per environment. This is the contract between the server, the file source,
and the engine. Published as a JSON Schema; `coduck-flags validate` enforces it.

```jsonc
{
  "version": 7,                       // monotonic; bumped on every change (staleness + ordering)
  "environment": "production",
  "updatedAt": "2026-07-25T12:00:00Z",
  "segments": {
    "internal": {
      "conditions": [
        { "attribute": "email", "op": "endsWith", "value": "@coduck.ai" }
      ]
    },
    "beta": {
      "conditions": [
        { "attribute": "segmentIds", "op": "contains", "value": "beta" }
      ]
    }
  },
  "flags": {
    "new-checkout": {
      "type": "boolean",
      "enabled": true,                // MASTER KILL SWITCH. false → serve offVariation, skip everything
      "variations": [false, true],    // boolean convention: index 0 = off, 1 = on
      "offVariation": 0,              // served when enabled=false
      "default": 0,                   // "fallthrough": served when enabled but nothing matches
      "targets": [
        { "variation": 1, "keys": ["user_ceo", "user_qa"] }   // individual overrides, checked first
      ],
      "rules": [
        {
          "id": "paid-25pct",
          "conditions": [
            { "attribute": "plan", "op": "in", "value": ["plus", "studio"] }
          ],
          "serve": {
            "rollout": {              // 25% of matching (paid) users get "on"
              "bucketBy": "key",
              "salt": "paid-25pct",
              "splits": [
                { "variation": 1, "weight": 2500 },
                { "variation": 0, "weight": 7500 }
              ]
            }
          }
        },
        {
          "id": "internal-on",
          "conditions": [
            { "attribute": "$segment", "op": "in", "value": ["internal"] }
          ],
          "serve": { "variation": 1 }  // fixed serve (no bucketing)
        }
      ]
    },

    "cta-color": {
      "type": "multivariate",
      "enabled": true,
      "variations": ["control", "blue", "green"],
      "offVariation": 0,
      "default": 0,
      "targets": [],
      "rules": [
        {
          "id": "everyone-abc",
          "conditions": [],           // no conditions → matches all
          "serve": {
            "rollout": {
              "bucketBy": "key",
              "salt": "cta-color-v1",
              "splits": [
                { "variation": 0, "weight": 3400 },
                { "variation": 1, "weight": 3300 },
                { "variation": 2, "weight": 3300 }
              ]
            }
          }
        }
      ]
    }
  }
}
```

### Condition operators (Phase 0 set)
`eq`, `neq`, `in`, `notIn`, `contains`, `notContains`, `startsWith`, `endsWith`,
`gt`, `gte`, `lt`, `lte`, `exists`, `notExists`.

- `$segment` is a reserved attribute: `{ "attribute": "$segment", "op": "in", "value": ["beta"] }`
  matches if the context satisfies that segment's own conditions (one level of nesting; no
  segment-references-segment in Phase 0, to keep evaluation non-recursive and cheap).
- Missing attribute → the condition evaluates `false` (except `notExists`, which is `true`).
  Never an error.
- All conditions in a rule are AND'd. OR is expressed as multiple rules.

### `serve` is one of
- `{ "variation": <index> }` — fixed.
- `{ "rollout": { "bucketBy", "salt", "splits": [{ "variation", "weight" }] } }` — weighted,
  deterministic. Weights are integers summing to **10000** (0.01% precision). Validation fails
  if they don't sum to 10000.

---

## 5. Evaluation algorithm

`evaluate(ruleset, flagKey, context, callerDefault) → { value, variationIndex, reason }`

Order (mirrors the battle-tested LaunchDarkly model — targets → rules → fallthrough → off):

1. **Flag missing** from ruleset → `{ value: callerDefault, variationIndex: -1, reason: "FLAG_NOT_FOUND" }`.
2. **`enabled === false`** → serve `offVariation` → `reason: "DISABLED"` *(the kill switch;
   short-circuits everything below).*
3. **Targets** — if `context.key` ∈ any `target.keys` → that variation → `reason: "TARGET_MATCH"`.
4. **Rules** — first rule whose conditions all match:
   - fixed serve → that variation → `reason: "RULE_MATCH:<ruleId>"`
   - rollout → bucket the context (§6), pick the split → `reason: "RULE_MATCH:<ruleId>"`
5. **Fallthrough** — no rule matched → serve `default` → `reason: "FALLTHROUGH"`.
6. **Any thrown error** anywhere (malformed rule, bucketing key absent for a rollout, etc.) is
   caught → `{ value: callerDefault, variationIndex: -1, reason: "ERROR" }`. The engine never
   propagates exceptions to the caller.

`value` is `variations[variationIndex]`. The `reason` is first-class output — it powers
debugging, the CLI `eval` dry-run, and (Phase 1) exposure logging for experiments.

---

## 6. Bucketing spec (pinned — this is what makes rollouts correct)

Chosen for **cross-language parity above cleverness**: FNV-1a (32-bit) is a handful of lines
that every language implements identically, which is exactly what you want when a Python or Go
SDK must bucket a user the same as Node. (The specific hash matters far less than specifying
it exactly and shipping golden vectors — but we commit to one.)

```
bucketKeyValue = context[rollout.bucketBy]        // usually context.key (the stable identity)
input          = bucketKeyValue + ":" + flagKey + ":" + rollout.salt
h              = fnv1a_32(input)                   // uint32, offset basis 2166136261, prime 16777619
bucket         = h % 10000                         // integer in [0, 9999]
```

Pick a variation by walking cumulative split weights:

```
cursor = 0
for split in rollout.splits:          // order is significant and part of the spec
    cursor += split.weight            // weights sum to 10000
    if bucket < cursor: return split.variation
return last split.variation           // guards against rounding
```

**Guaranteed properties (all covered by tests):**
- **Sticky** — same `bucketKeyValue` + same `flagKey` + same `salt` → same bucket forever. No
  flicker across requests, processes, or restarts.
- **Monotonic ramps** — raising a variation's weight (10%→20%) only *adds* users to it; the
  original cohort keeps its value. Falls out of stable bucketing + append-ordered splits.
- **Decorrelated** — the per-rule `salt` means two different 10% rollouts hit *different* 10%
  cohorts. (Never reuse a salt across flags you don't want correlated.)
- **Uniform** — over N random keys, a weight-`w` split gets `w/10000 · N ± sampling noise`.
- **No bucketing key** → the rollout can't be computed → the flag falls through to `default`
  (a rollout requires a stable key by definition). Documented, tested, never an error.

---

## 7. SDK surface (`@coduck/flags`)

Tiny, impossible-to-misuse, every call defaulted, nothing throws.

```ts
const client = createClient({
  source:
    | { type: "file", path: "./flags.json", watch?: boolean }
    | { type: "http", url: string, sdkKey: string,
        pollIntervalMs?: number /* default 30000 */, stream?: boolean /* default true = SSE */ },
  environment?: string,          // default "production"
  bootstrap?: Ruleset,           // last-known-good for instant, offline-safe start
  cache?: { path: string },      // persist last-good ruleset to disk (fail-static across restarts)
  onError?: (err: FlagError) => void,
  logger?: Logger,
});

// context: { key: string /* required, stable bucketing/identity key */, ...attributes }

client.isEnabled(key, context, { default: boolean }): boolean
client.variant(key, context, { default: string }): string
client.evaluate(key, context, { default }): { value, variationIndex, reason }   // full detail
client.allFlags(context): Record<string, unknown>   // evaluate every flag (browser bootstrap)

client.getRulesetMeta(): { version, updatedAt, environment, ageMs, source: "server"|"cache"|"bootstrap"|"file" }
client.waitUntilReady(): Promise<void>              // optional: gate first request on first sync
client.on("ready" | "update" | "stale" | "error", cb)
client.close(): void
```

Behavior guarantees:
- Constructing the client **never blocks and never throws.** It serves `bootstrap` → `cache` →
  caller `default` (in that order) until the first sync completes; `waitUntilReady()` is opt-in
  for callers who prefer to gate.
- **Atomic swap** — a refreshed ruleset replaces the previous one in a single assignment; an
  eval never observes a half-applied update.
- **Staleness** — if neither SSE nor polling has produced an update within a configurable
  max-age, the client emits `"stale"` (so you can alert) but keeps serving last-known-good.
  Reconnect uses exponential backoff and pulls a full snapshot on reconnect to catch missed
  changes.
- **`allFlags` is the only sanctioned browser path** (Phase 0.5): evaluate server-side, ship
  the *results* to the client. The raw ruleset never leaves the server.

---

## 8. Reference server (`@coduck/flags-server`)

Single process, no external services. Source of flags = a `flags.json` file **or** an embedded
SQLite store (chosen at start). This is what proves the live-flip demo without CoDuck infra.

Endpoints:
- `GET /rulesets/:environment` — current snapshot. Requires a **read/SDK key**. Returns
  `version`, `updatedAt`, `ETag`; supports conditional GET.
- `GET /rulesets/:environment/stream` — **SSE**. Pushes the new snapshot whenever a flag
  changes. This is the "instant, no restart" path.
- `POST /flags/:key/state` etc. — write ops (toggle, set rollout). Requires a separate
  **admin key**. Used by the CLI. On success: bump `version`, persist, and fan out over SSE
  to all connected SDKs (in-process event emitter / file-watch — no Redis needed at this
  scale).
- `GET /health` — readiness/liveness.

Explicitly deferred to Phase 1: multi-tenant isolation, RBAC beyond the two keys, audit log,
CDN delivery, Postgres `LISTEN/NOTIFY` fan-out. Phase 0 is single-tenant, single-node, and
says so.

---

## 9. CLI (`coduck-flags`)

Every server capability is reachable from the CLI (matches CoDuck's "every route ships a CLI
command" discipline) and it doubles as a local, backend-free tool.

```
coduck-flags init                                 # scaffold flags.json + schema
coduck-flags validate [--file flags.json]         # JSON-Schema check; exit non-zero on error
coduck-flags list [--env production]
coduck-flags on  <key>                            # master kill switch on
coduck-flags off <key>                            # master kill switch off  ← the "button"
coduck-flags rollout <key> --percent 10 [--to "plan in [plus,studio]"]   # set a % rule
coduck-flags variant <key> --splits control=34,blue=33,green=33
coduck-flags target  <key> --on user_123,user_456 # individual overrides
coduck-flags eval <key> --context '{"key":"u1","plan":"studio"}'   # dry-run, prints value+reason
coduck-flags serve [--port 8787] [--store flags.json|sqlite]        # run the reference server
```

`eval` running the *real engine* locally is the fastest way to test targeting and is used in
the docs to explain rules.

---

## 10. OpenFeature provider (`@coduck/flags-openfeature`)

Implements the OpenFeature JS provider interface on top of `@coduck/flags`, so users can adopt
the vendor-neutral `@openfeature/server-sdk` API and drop CoDuck in underneath — no lock-in.

- Maps OpenFeature's `EvaluationContext` → our `context` (`targetingKey` → `context.key`).
- Maps our `reason` → OpenFeature reasons (`TARGET_MATCH`, `SPLIT`, `DEFAULT`, `DISABLED`,
  `ERROR`, …).
- Passes the official OpenFeature provider compatibility test suite in CI (a concrete,
  external correctness bar — great for the portfolio).

---

## 11. Quality bar & testing

- **Golden test vectors** (`@coduck/flags-test-vectors`) — a language-agnostic JSON corpus:
  (a) `input → expected bucket`, (b) `ruleset + context → expected variationIndex + reason`.
  Every SDK, in any language, must pass these. This *is* the cross-language parity guarantee.
- **Property / fuzz tests** — determinism (same input → same output), monotonic ramp
  (increasing weight never flips a bucketed user off), uniform distribution within tolerance
  over large N, "never throws" under randomized/malformed rulesets.
- **Benchmark** — evals/sec on one core, published in the README (target: >1M simple boolean
  evals/sec; the point is "the DB is never in the hot path"). CI tracks regressions.
- **Coverage** — 100% on `core` (it's small and load-bearing).
- **OpenFeature compat suite** — green in CI.
- **Examples run in CI** — the Express and Next.js examples boot and pass a smoke test.

---

## 12. Definition of done

Phase 0 ships when all are true:

1. `npm i @coduck/flags`, point at a `flags.json`, `isEnabled`/`variant` work with **zero
   backend**.
2. **The live-flip demo:** `coduck-flags serve` + an app on the HTTP source → `coduck-flags off
   <key>` in another terminal → the app reflects it in **< 1s, no restart**; kill the server →
   the app keeps serving last-known-good.
3. Rollouts are **sticky, monotonic, decorrelated**, proven by the golden vectors + property
   tests.
4. The SDK **never throws** and **never blocks startup** under any source failure (tested with
   an unreachable/served-garbage source).
5. OpenFeature provider passes the compat suite.
6. Docs site live: 30-second quickstart, the schema reference, the **security invariants**
   (§2) front-and-center, and the published benchmark.
7. README leads with the quickstart and the "flags are not authorization" warning.

---

## 13. Build order (within Phase 0)

1. **`core`** — schema + JSON Schema + eval algorithm + FNV-1a bucketing + golden vectors +
   property tests. (Nothing else can be trusted until this is.)
2. **`sdk-node`** — file source + fail-static + `evaluate`/`isEnabled`/`variant`/`allFlags`.
3. **HTTP source** — polling refresh + on-disk cache + staleness events.
4. **`server` + SSE + `cli` toggle** — wire up and land the **live-flip demo** (the headline).
5. **`openfeature`** — provider + compat suite.
6. **Docs, benchmark, examples, README** — the portfolio surface.

---

## 14. Open decisions (carried from planning — resolve before/while building)

- **OSS-first vs CoDuck-first.** This spec assumes OSS-standalone first; Phase 1 consumes it.
- **How generous is the OSS line.** Phase 0 has no dashboard (CLI + files only). A minimal OSS
  dashboard could drive adoption but expands scope — currently deferred to Phase 1/managed.
- **Bucketing hash.** Committed to FNV-1a (32-bit) for parity/simplicity; revisit only if a
  distribution or performance issue shows up in the benchmark (none expected).
- **Product name.** Package stays literal (`@coduck/flags`); optional marketing name (e.g.
  "Decoy") is cosmetic and independent of this spec.
