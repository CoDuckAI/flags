# `@coduck/flags-openfeature`

An OpenFeature server provider backed by `@coduck/flags`. Applications can use the
vendor-neutral OpenFeature API while CoDuck performs deterministic local evaluation.

```bash
pnpm add @coduck/flags @coduck/flags-openfeature @openfeature/server-sdk
```

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createOpenFeatureProvider } from "@coduck/flags-openfeature";

await OpenFeature.setProviderAndWait(createOpenFeatureProvider(flags));
const client = OpenFeature.getClient();
const enabled = await client.getBooleanValue("new-checkout", false, {
  targetingKey: account.id
});
```

The provider supports boolean, string, number, and object resolution. CoDuck errors map to
OpenFeature error codes, and stale source state is exposed as the standard `STALE` reason while
the last valid value remains available.
