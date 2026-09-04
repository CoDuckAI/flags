# `@coduckai/flags-management`

The UI-independent administrative SDK for CoDuck Flags. It publishes complete validated
ruleset revisions with optimistic concurrency and exposes small helpers for common changes.
A dashboard, internal admin route, automation, or script can all use the same API.

```sh
npm install @coduckai/flags-management
```

```ts
import { createManagementClient } from "@coduckai/flags-management";

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

## Important semantics

- `setBooleanRollout()` accepts 0–100 with at most two decimal places. It creates or replaces
  an ordered rule, not the whole flag. Earlier matching rules and exact targets retain priority.
- Keep `ruleId`, `bucketBy` and `conditions` the same when expanding a cohort. Omitting
  `conditions` on a later call removes that named rule's eligibility filter.
- `setEnabled(..., false)` serves `offVariation` before every target and rule once the new
  revision reaches a client. `true` restores normal evaluation; it does not force the flag on.
- `setTarget()` moves one targeting key to the requested named variation, overriding rules.
- `createEnvironment()` is a one-time initialization; an existing environment is a conflict.
- `update()` may invoke its synchronous mutation callback more than once after a conflict.
  Keep that callback free of external side effects. It overwrites revision/timestamp fields.
- `publishRuleset(ruleset, expectedRevision)` is the low-level complete-snapshot operation.
  Use `null` only when creating an environment. Inspect `ManagementApiError.status` on failure.

See the [repository README](https://github.com/CoDuckAI/flags#readme) for the full workflow.
