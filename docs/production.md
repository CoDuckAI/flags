# Integrate and operate Flags

The SDK handles evaluation and configuration lifecycle. Your application owns identity,
authorization, feature implementation, deployment, and monitoring.

## Choose a source

| Source                                     | Use it for                                                           | Update behavior                  |
| ------------------------------------------ | -------------------------------------------------------------------- | -------------------------------- |
| `staticSource(ruleset)`                    | A fixed validated snapshot, tests or a simple embedded integration   | No live updates                  |
| `fileSource({ path })`                     | Configuration delivered through your existing file/deployment system | Watch plus polling               |
| `httpSource({ url, environment, sdkKey })` | Live server-managed releases                                         | SSE plus conditional polling     |
| Custom `FlagSource`                        | Your own storage/transport integration                               | Your adapter implements delivery |

Custom sources must honor the boolean returned by `onSnapshot`: advance ETags or other delivery
cursors only for accepted snapshots. Invalid configuration must not poison a delivery cursor.

## Hosting the optional server

The reference server is a Node.js library, not a separate required product. This setup stores
snapshots on disk. Set two distinct secrets of at least 16 characters in your environment:

```js
import { createFlagServer, FileRulesetStore } from "@coduckai/flags-server";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const server = createFlagServer({
  store: new FileRulesetStore("./data/rulesets.json"),
  readKeys: [required("FLAGS_SDK_KEY")],
  adminKeys: [required("FLAGS_ADMIN_KEY")],
  host: "127.0.0.1",
  port: 8080
});

await server.start();
```

Put TLS and your normal network/access controls in front of it. Preserve SSE streaming through
the proxy, restrict the administration credential to trusted backend code, and mount the data
directory on persistent storage. Initialize an environment once with
`admin.createEnvironment({ environment, flags, segments })`; an existing environment is a
conflict, not something to overwrite on every process start.

The memory store is ephemeral. The file store provides atomic replacement for one server
process; sharing a file between writers is not distributed coordination. A multi-node deployment
needs a shared `RulesetStore` with atomic revision checks **and** an appropriate cross-node
delivery strategy. That deployment is not part of the reference server's proof.

## Connect the application

```js
import { createClient, fileCache, httpSource } from "@coduckai/flags";

const flags = createClient({
  environment: "production",
  source: httpSource({
    url: process.env.FLAGS_URL,
    environment: "production",
    sdkKey: process.env.FLAGS_SDK_KEY
  }),
  cache: fileCache("./.coduck-flags/production.json"),
  staleAfterMs: 90_000,
  onError: (error) => console.warn("Flag configuration error:", error.message)
});

await flags.waitUntilReady({ timeoutMs: 5_000 });
```

Validate environment variables at startup as in the server example. Reuse the client for
requests. Use distinct cache files per environment, and call `await flags.close()` during
shutdown to release streams/watchers and finish pending cache writes.

Readiness can come from a cached snapshot. It does not prove live connectivity. If startup
must require fresh configuration, check `getStatus().stale` and apply your own readiness policy.
If you deliberately start without configuration, catch the readiness error and rely on explicit
caller defaults; do not accidentally turn a failed initialization into an unhandled rejection.

## Observability

There are three different things to measure:

1. **Configuration received:** report instance ID, environment, accepted revision and stale state.
2. **Variant assigned:** report evaluation variant, reason and revision as needed.
3. **Feature experienced:** emit an application-owned event when the feature is actually used or rendered.

The SDK exposes these hooks without sending anything to CoDuck:

```js
flags.on("update", (status) => console.log("Configuration accepted", status));
flags.on("stale", (status) => console.warn("Configuration stale", status));
flags.on("healthy", (status) => console.log("Configuration recovered", status));
flags.on("evaluation", (event) => console.log("Flag evaluated", event));
```

Replace console calls with your own metrics/telemetry. Sample or aggregate high-volume
evaluations. SDK evaluation events deliberately omit targeting keys and context attributes.
If your app needs account-level exposure analysis, use an application-owned pseudonymous ID,
appropriate consent/retention controls, and deduplication; do not put personal data in rulesets.

An evaluation event is not an exposure event. An accepted server write is not confirmation
that all application instances received it. Offline instances keep last-known-good state and
may not receive a new kill switch until connectivity returns. There is no fleet-wide delivery
acknowledgement service built into this SDK.

## Release checklist for your application

- Verify real authenticated attributes and a stable identity convention.
- Prove both eligible and ineligible account journeys, including explicit holdouts.
- Check that an enabled flag actually changes the feature, not just a debug label.
- Observe revision propagation across independent application instances.
- Exercise stale/offline startup, reconnects, malformed updates, and the kill switch.
- Keep old code and data compatibility during the ramp; flags do not undo a database migration.
- Use the SDK as a feature gate, never as the only authorization or entitlement check.

## Security and support scope

The runtime is server-side. Do not expose bearer keys or complete rulesets to browsers.
Treat administration access as production-change access. Review the
[security policy](../SECURITY.md) before deployment.

The 0.x API is an early release line; minor versions may include documented breaking changes.
Pin a tested version for critical applications and review the [changelog](../CHANGELOG.md)
before upgrades. Schema version 1 and its golden vectors are explicitly versioned compatibility
contracts; the package version and ruleset schema version are different numbers.
