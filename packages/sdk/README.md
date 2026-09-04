# `@coduck/flags`

The server-side runtime SDK for CoDuck Flags. Evaluations are synchronous and local.
Configuration can come from a static object, a watched JSON file, an HTTP/SSE source,
or an application-provided adapter. Source failures never replace a valid snapshot.

```bash
pnpm add @coduck/flags
```

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
const enabled = flags.isEnabled("new-checkout", { targetingKey: account.id }, { default: false });
```

Evaluation never performs network I/O. `evaluate()` returns full resolution details;
`isEnabled()`, `variant()`, `number()`, and `json()` return typed values. Every call requires a
safe caller default. Cached snapshots remain marked stale until the source confirms them.

Custom sources implement `FlagSource`. Their `onSnapshot` callback returns whether the runtime
accepted the snapshot; delivery cursors such as ETags must advance only when it returns `true`.

See the [repository README](https://github.com/CoDuckAI/flags#readme) and
[v1 contract](https://github.com/CoDuckAI/flags/blob/main/SPEC.md) for the complete model.
