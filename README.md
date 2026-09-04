# CoDuck Flags

**Deploy once. Release gradually. Roll back instantly.**

CoDuck Flags is a headless, TypeScript-first feature rollout SDK. The application evaluates
flags synchronously from an immutable in-memory snapshot; configuration refresh happens in
the background. Use a local JSON ruleset, embed the reference server, or provide your own
source and storage adapters. No dashboard or hosted CoDuck account is required.

> [!IMPORTANT]
> Feature flags are not authorization. Continue enforcing permissions, plan entitlements,
> and access control independently on the server.

## What ships

| Package                      | Purpose                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `@coduck/flags`              | Runtime SDK, local evaluation, file/HTTP sources and last-good cache            |
| `@coduck/flags-core`         | Zero-dependency ruleset validator, targeting engine and deterministic bucketing |
| `@coduck/flags-management`   | UI-independent management SDK with optimistic concurrency                       |
| `@coduck/flags-server`       | Optional embeddable HTTP/SSE reference server and file/memory stores            |
| `@coduck/flags-openfeature`  | OpenFeature server provider                                                     |
| `@coduck/flags-test-vectors` | Cross-language hashing and bucketing compatibility values                       |

The server is a thin transport/storage adapter around the SDK contract. A UI, automation,
or internal admin tool can use the management SDK without requiring a CoDuck-provided UI.

## Local quickstart

```ts
import { createClient, defineRuleset, staticSource } from "@coduck/flags";

const ruleset = defineRuleset({
  schemaVersion: 1,
  revision: 1,
  environment: "production",
  updatedAt: new Date().toISOString(),
  segments: {},
  flags: {
    "new-agent": {
      type: "boolean",
      enabled: true,
      variations: { off: false, on: true },
      offVariation: "off",
      defaultVariation: "off",
      targets: [],
      rules: [
        {
          id: "public-rollout",
          conditions: [],
          serve: {
            rollout: {
              bucketBy: "targetingKey",
              salt: "new-agent:public-rollout",
              splits: [
                { variation: "on", weight: 1000 },
                { variation: "off", weight: 9000 }
              ]
            }
          }
        }
      ]
    }
  }
});

const flags = createClient({ source: staticSource(ruleset) });
await flags.waitUntilReady();

const enabled = flags.isEnabled(
  "new-agent",
  { targetingKey: account.id, plan: account.plan },
  { default: false }
);
```

Weights are basis points and must total 10,000. Stable UTF-8 FNV-1a bucketing means the same
targeting key, flag key, and salt always produce the same assignment. Put the new variation
first when ramping a boolean rollout so increasing 10% to 20% only adds accounts.

For business products, use an account or organization ID as `targetingKey` when everyone in
that organization should move together.

## Live configuration

Embed the optional reference server in any Node process:

```ts
import { createFlagServer, MemoryRulesetStore } from "@coduck/flags-server";

const server = createFlagServer({
  store: new MemoryRulesetStore([ruleset]),
  readKeys: [process.env.FLAGS_SDK_KEY!],
  adminKeys: [process.env.FLAGS_ADMIN_KEY!]
});

const { url } = await server.start();
```

Point the runtime SDK at it. SSE delivers changes immediately; conditional HTTP polling is
the recovery path. Evaluation itself never performs I/O.

```ts
import { createClient, fileCache, httpSource } from "@coduck/flags";

const flags = createClient({
  environment: "production",
  source: httpSource({
    url: process.env.FLAGS_URL!,
    environment: "production",
    sdkKey: process.env.FLAGS_SDK_KEY!
  }),
  cache: fileCache("./.coduck-flags/production.json"),
  staleAfterMs: 90_000,
  onError: (error) => logger.warn({ error }, "Flag source problem")
});
```

Manage it through code—not a required CLI:

```ts
import { createManagementClient } from "@coduck/flags-management";

const admin = createManagementClient({
  url: process.env.FLAGS_URL!,
  adminKey: process.env.FLAGS_ADMIN_KEY!
});

await admin.setBooleanRollout("new-agent", 25, { environment: "production" });
await admin.setEnabled("production", "new-agent", false); // kill switch
```

The rollout helper appends its rule so existing, more-specific targeting rules keep priority.
Updating that rollout later preserves its position and salt.

Every publish is a complete validated snapshot with a monotonic revision. Concurrent writers
use `If-Match`; stale writes fail rather than silently overwriting newer configuration.

## Evaluation order

1. Missing flag or type mismatch → caller default with an error reason.
2. Disabled flag → `offVariation` immediately.
3. Exact targeting-key overrides.
4. First matching ordered rule, including reusable segments.
5. Stable percentage split when the rule serves a rollout.
6. `defaultVariation` when nothing matches.

`evaluate()` returns the value, named variant, reason, matched rule, environment and revision.
Convenience methods return only the typed value. `evaluateMany()` requires an explicit map of
defaults; that map is also an allowlist, preventing accidental exposure of backend-only flags.

## Failure behavior

- Evaluations are synchronous, local, and do not throw.
- Invalid snapshots are rejected and reported without replacing the current snapshot.
- A revision cannot change content without being incremented.
- Older revisions are ignored.
- File persistence uses an atomic temporary-write-and-rename operation.
- HTTP delivery requires TLS except on localhost or explicit development overrides.
- Read and administration credentials are separate.
- Source failures leave the last valid snapshot active.
- A disk-cached snapshot is immediately usable but remains marked stale until a live source confirms it.
- `getStatus()` exposes revision, source, freshness and staleness for health checks.
- Evaluation telemetry excludes the targeting key and all context attributes by design.

## OpenFeature

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createOpenFeatureProvider } from "@coduck/flags-openfeature";

await OpenFeature.setProviderAndWait(createOpenFeatureProvider(flags));
const client = OpenFeature.getClient();
const enabled = await client.getBooleanValue("new-agent", false, {
  targetingKey: account.id
});
```

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm check
pnpm benchmark
```

See [SPEC.md](./SPEC.md) for the stable evaluation and delivery contracts, and
[SECURITY.md](./SECURITY.md) for the trust boundaries.
