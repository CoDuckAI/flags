# `@coduck/flags-management`

The UI-independent administrative SDK for CoDuck Flags. It publishes complete validated
ruleset revisions with optimistic concurrency and exposes small helpers for common changes.
A dashboard, internal admin route, automation, or script can all use the same API.

```bash
pnpm add @coduck/flags-management
```

```ts
import { createManagementClient } from "@coduck/flags-management";

const flags = createManagementClient({
  url: process.env.FLAGS_URL!,
  adminKey: process.env.FLAGS_ADMIN_KEY!
});

await flags.setBooleanRollout("new-checkout", 25, { environment: "production" });
await flags.setTarget("production", "new-checkout", "account_123", "on");
await flags.setEnabled("production", "new-checkout", false); // kill switch
```

`update()` reads the latest snapshot, applies a mutation, and publishes with `If-Match`. Revision
conflicts are retried without silently overwriting another writer. Management credentials must
never be shipped to browsers.

See the [repository README](https://github.com/CoDuckAI/flags#readme) for the full workflow.
