# `@coduck/flags`

The server-side runtime SDK for CoDuck Flags. Evaluations are synchronous and local.
Configuration can come from a static object, a watched JSON file, an HTTP/SSE source,
or an application-provided adapter. Source failures never replace a valid snapshot.

Node.js 22.13+, ESM and CommonJS, with TypeScript declarations. The package depends only on
`@coduck/flags-core` at runtime. No hosted account or outbound telemetry is required.

During the initial release, see the [installation status and tarball instructions](https://github.com/CoDuckAI/flags#install)
before using the planned registry command: `npm install @coduck/flags`.

```ts
import { createClient, fileCache, httpSource } from "@coduck/flags";

const flags = createClient({
  environment: "production",
  source: httpSource({
    url: process.env.FLAGS_URL!,
    environment: "production",
    sdkKey: process.env.FLAGS_SDK_KEY!
  }),
  cache: fileCache("./.coduck-flags/production.json")
});

await flags.waitUntilReady();
const enabled = flags.isEnabled("new-checkout", { targetingKey: "org_123" }, { default: false });
```

Evaluation never performs network I/O. `evaluate()` returns full resolution details;
`isEnabled()`, `variant()`, `number()`, and `json()` return typed values. Every call requires a
safe caller default. Cached snapshots remain marked stale until the source confirms them.

Validate the environment variables before constructing this client. Create one client per
environment per application process; reuse it for requests and call `await flags.close()`
on shutdown. The HTTP source assumes the environment and flags have already been created.
For a complete example with no server, use the [local quickstart](https://github.com/CoDuckAI/flags#quickstart).

## API at a glance

| Method                                          | Result                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `evaluate(key, context, { default })`           | Value, named variant, reason, rule ID and revision metadata             |
| `isEnabled(key, context, { default: false })`   | Boolean flag value                                                      |
| `variant(key, context, { default: "classic" })` | String flag value, not the named variation ID                           |
| `number(key, context, { default: 10 })`         | Numeric flag value                                                      |
| `json(key, context, { default: {} })`           | JSON object/array flag value                                            |
| `evaluateMany(defaults, context)`               | Details for exactly the flag keys in the explicit defaults map          |
| `waitUntilReady({ timeoutMs })`                 | Resolves when usable configuration exists; rejects on timeout/close     |
| `getStatus()`                                   | Readiness, source, accepted revision and freshness                      |
| `refresh()`                                     | Requests a source refresh                                               |
| `on(event, listener)`                           | Returns an unsubscribe function                                         |
| `close()`                                       | Closes sources, rejects pending readiness waits and drains cache writes |

`waitUntilReady()` is not a fleet acknowledgement or a guarantee of freshness. Inspect
`getStatus().stale` when freshness matters. Evaluation events contain no targeting keys or
context attributes; add application-owned exposure instrumentation at the point of actual use.

## Sources and cache

`staticSource(ruleset)` fixes a snapshot, `fileSource({ path })` watches and polls a JSON file,
and `httpSource({ url, environment, sdkKey })` receives SSE with polling fallback. `fileCache(path)`
persists last-known-good configuration. Use a different cache path per environment.

Custom sources implement `FlagSource`. Their `onSnapshot` callback returns whether the runtime
accepted the snapshot; delivery cursors such as ETags must advance only when it returns `true`.

Do not send full rulesets or bearer keys to a browser. The runtime SDK is server-side; return
only an explicit allowlist of evaluated values from your own backend. Flags do not replace
authentication, authorization or plan entitlements.

See the [repository README](https://github.com/CoDuckAI/flags#readme) and
[v1 contract](https://github.com/CoDuckAI/flags/blob/main/SPEC.md) for the complete model.
