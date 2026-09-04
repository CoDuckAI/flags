# CoDuck Flags

**Deploy the code. Decide who gets it.**

[![CI](https://github.com/CoDuckAI/flags/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CoDuckAI/flags/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178c6.svg)](packages/sdk)

A headless feature-flag and rollout SDK for Node.js applications. Evaluate flags locally,
target accounts or attributes, grow a stable percentage cohort, and turn a feature off
without another deployment. Your application owns the UI. Your infrastructure owns the data.

No hosted account. No dashboard dependency. No product CLI. No network request when you
evaluate a flag.

[Quickstart](#quickstart) · [Live rollouts](#change-a-rollout-without-redeploying) ·
[Targeting](docs/targeting.md) · [Production guide](docs/production.md) ·
[Proof](proof/flags-sdk/REPORT.md) · [Releases](https://github.com/CoDuckAI/flags/releases)

> **Release status:** `0.1.0` is the initial SDK release line. npm publication is pending;
> the package names below are not yet installable from the public npm registry.
> Build and install the verified tarballs using the instructions below.

## Why Flags?

- **Local decisions.** Synchronous evaluation from a validated, immutable snapshot.
- **Predictable targeting.** Exact account overrides, attributes, reusable segments, and ordered rules.
- **Stable ramps.** Keep the same accounts selected as a two-variant rollout grows.
- **Live configuration.** HTTP/SSE updates, polling recovery, watched files, or your own source adapter.
- **Explicit failure behavior.** Last-known-good configuration, caller defaults, and observable stale state.
- **SDK all the way down.** The management API can power your own admin UI, application route, or automation.
- **Portable integration.** TypeScript declarations, ESM and CommonJS, an optional OpenFeature provider, and an MIT license.

Use it when you want release controls inside your own application. It is not an experiment
analytics platform, an authorization system, or a managed multi-region control plane.

## Install

Node.js **20.19+** is required for the runtime and server packages. Use a supported Node.js
release for production. Package names shown here are not a claim of registry availability.

Until npm publication, build from this repository:

```sh
git clone --branch feat/oss-sdk-v1 https://github.com/CoDuckAI/flags.git
cd flags
pnpm install --frozen-lockfile
pnpm release:pack
```

The implementation currently lives on `feat/oss-sdk-v1` ([PR #1](https://github.com/CoDuckAI/flags/pull/1));
the default branch has not yet received the SDK. Repository access is required while it remains private.

`release:pack` builds six packages, checks their contents and licenses, installs the real
tarballs in a clean consumer project, executes both examples, and checks TypeScript imports.
The resulting archives and checksums are in `release/0.1.0/`.

From your application's directory, install the core and runtime together:

```sh
npm install /path/to/flags/release/0.1.0/coduck-flags-core-0.1.0.tgz \
  /path/to/flags/release/0.1.0/coduck-flags-0.1.0.tgz
```

After public npm publication, the equivalent command will be `npm install @coduck/flags`.
The Git repository is a monorepo, not a directly installable npm package; install its package
tarballs rather than passing the Git URL to `npm install`.

## Quickstart

This complete example enables a checkout for Pro accounts and leaves everyone else on the
current experience. Save it as `quickstart.mjs` and run `node quickstart.mjs`.

<!-- example: examples/quickstart.mjs -->

```js
import { createClient, defineRuleset, staticSource } from "@coduck/flags";

const ruleset = defineRuleset({
  schemaVersion: 1,
  revision: 1,
  environment: "production",
  updatedAt: new Date().toISOString(),
  segments: {},
  flags: {
    "new-checkout": {
      type: "boolean",
      enabled: true,
      variations: { off: false, on: true },
      offVariation: "off",
      defaultVariation: "off",
      targets: [],
      rules: [
        {
          id: "pro-beta",
          conditions: [{ attribute: "plan", op: "eq", value: "pro" }],
          serve: { variation: "on" }
        }
      ]
    }
  }
});

const flags = createClient({ source: staticSource(ruleset) });
await flags.waitUntilReady();

const result = flags.evaluate(
  "new-checkout",
  { targetingKey: "org_123", plan: "pro" },
  { default: false }
);

console.log(result.value, result.reason, result.ruleId);
// true TARGETING_MATCH pro-beta

await flags.close();
```

<!-- /example -->

Use an authenticated account or organization ID as `targetingKey` when everyone in that
organization should get the same experience. Use a user ID for individual rollouts.
Supply attributes from trusted application state—not from an unverified browser request.

Create one long-lived client per environment per application process, reuse it for requests,
and close it during shutdown. `staticSource` is fixed configuration; use a file or HTTP source
when you want updates without restarting.

## Change a rollout without redeploying

The optional server distributes configuration. The management SDK edits it. Your running
application keeps evaluating its local snapshot.

```text
Your admin UI or automation → management SDK → your configuration server
                                                       ↓ HTTP/SSE
                                              application SDK → feature
                                              local evaluation
```

Once a flag exists, management operations are ordinary code:

```js
import { createManagementClient } from "@coduck/flags-management";

const admin = createManagementClient({
  url: process.env.FLAGS_URL,
  adminKey: process.env.FLAGS_ADMIN_KEY
});

await admin.setBooleanRollout("new-checkout", 10, { environment: "production" });
await admin.setBooleanRollout("new-checkout", 25, { environment: "production" });
await admin.setBooleanRollout("new-checkout", 100, { environment: "production" });
await admin.setEnabled("production", "new-checkout", false); // emergency shutoff
```

Start with an off-by-default flag, for example `booleanFlag({ default: false })` from the
management package. The rollout helper appends an ordered rule; earlier matching rules and
exact targets still take priority. A 100% rollout is not an override of every other rule.
The kill switch is: once its revision arrives, `enabled: false` serves `offVariation` before
targets or rollout rules. An offline instance cannot receive a new kill-switch revision.

Run the complete local create → connect → release → disable example:

```sh
pnpm example:live
```

[Read the runnable example](examples/live-rollout.mjs) ·
[Set up persistent hosting](docs/production.md#hosting-the-optional-server)

## What does “25%” mean?

Flags deterministically hashes the targeting value, flag key, and salt into 10,000 buckets.
An on-first split with weight `2500` selects buckets below `2500`. Repeated evaluations do
not reroll a user's assignment.

Increasing that first split from 25% to 50% adds accounts without removing the original
cohort, provided the targeting value, flag key, salt, and eligibility conditions stay the
same. It is approximately 25% of identities—not a hard quota, not 25% of requests, and not
necessarily 25% of currently active users. Changing identity or salt changes assignment.

[Targeting recipes and rule precedence →](docs/targeting.md)

## Packages

Install only the pieces you need. Each package has its own README and public types.

| Package                                               | Responsibility                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@coduck/flags`](packages/sdk)                       | Node.js runtime: local evaluation, sources, cache, lifecycle and events     |
| [`@coduck/flags-core`](packages/core)                 | Zero-runtime-dependency evaluation and validation engine; JSON Schema       |
| [`@coduck/flags-management`](packages/management)     | Create environments, publish revisions, target accounts and change rollouts |
| [`@coduck/flags-server`](packages/server)             | Optional single-node HTTP/SSE server with memory and file stores            |
| [`@coduck/flags-openfeature`](packages/openfeature)   | Provider for the OpenFeature server SDK                                     |
| [`@coduck/flags-test-vectors`](packages/test-vectors) | Language-neutral hashing/bucketing compatibility vectors                    |

The runtime is server-side, not a browser SDK. Do not ship its keys or full rulesets to a
browser. Evaluate on your server and expose an explicit allowlist of results.

## When something fails

| Situation                                                 | Behavior                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| No usable configuration, missing flag or wrong type       | Return the caller's default and an error reason                  |
| Invalid incoming snapshot                                 | Reject it; retain the last valid snapshot and report the problem |
| Source unavailable                                        | Continue from the last valid snapshot; expose staleness          |
| Startup from disk cache                                   | Allow evaluation, but remain stale until live confirmation       |
| Older revision or changed content under the same revision | Do not replace the accepted snapshot                             |
| Concurrent management edits                               | Reject stale writes; `update()` retries revision conflicts       |
| Evaluation observer throws                                | Isolate the observer; do not break evaluation                    |

`waitUntilReady()` means usable configuration exists, not that every server has the newest
revision. Monitor `getStatus()` for freshness. Creation, validation, readiness, and management
operations can throw; flag evaluations return safe defaults with reason details.

## How do you know users got it?

Check three separate facts: the application **loaded the revision**, the account **was assigned
the expected variant**, and the application **actually used or displayed the feature**.

Flags exposes revision/status events and optional evaluation hooks. These do not automatically
record product exposure, send telemetry to CoDuck, or prove a customer saw a screen. Emit an
application-owned exposure event at the actual point of use and connect it to your monitoring.

[Operational checklist and observability →](docs/production.md)

## Verification

The committed baseline includes 71 automated tests, a million-evaluation monotonic ramp,
a million-identity distribution check, 24 concurrent writers, 9 real HTTP/SSE protocol checks,
and 38 browser assertions across eight recorded consumer journeys. Five viewport sizes were
checked. These are synthetic accounts and a real local SDK integration—not a claim of a
production rollout or a bug-free system.

The release gate also installs the packed SDK in a clean project. The quickstart shown above
is checked against its runnable source so documentation cannot silently drift from the example.

[Assertion ledger](proof/flags-sdk/REPORT.md) ·
[Download/open the recorded proof](proof/flags-sdk/REPORT.html) ·
[Evidence limits](proof/flags-sdk/VALIDATION.md) · [Test source](tests)

## Contribute and release

```sh
pnpm install --frozen-lockfile
pnpm check           # format, types, tests, coverage, packages and docs
pnpm proof           # real HTTP/SSE protocol checks
pnpm proof:browser   # recorded consumer journeys; needs Chrome/Playwright
pnpm release:pack    # build, pack, isolated install and consumer verification
```

Browser proof can use `PROOF_CHROME=/path/to/chrome`; otherwise install Chromium with
`pnpm exec playwright install chromium`. FFmpeg adds the shareable cursor-baked videos and GIF.

Read [CONTRIBUTING.md](CONTRIBUTING.md), the [versioned contract](SPEC.md),
[release instructions](RELEASING.md), and [changelog](CHANGELOG.md).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Built by [CoDuck](https://github.com/CoDuckAI).
