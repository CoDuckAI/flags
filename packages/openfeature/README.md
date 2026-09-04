# `@coduck/flags-openfeature`

An OpenFeature server provider backed by `@coduck/flags`. Applications can use the
vendor-neutral OpenFeature API while CoDuck performs deterministic local evaluation.

See the root [installation status](https://github.com/CoDuckAI/flags#install) during the initial
release. After npm publication:

```sh
npm install @coduck/flags @coduck/flags-openfeature @openfeature/server-sdk
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

This provider supports `@openfeature/server-sdk` versions `>=1.20.0 <2`; it is not a browser
provider. Create the underlying Flags client first as shown in the runtime README. Closing
the provider closes that client, so give it a dedicated client when lifecycles differ.

### TypeScript compatibility

The release consumer is checked with TypeScript 5.9 and `@types/node` 24.13.3, including
dependency declarations. The tested OpenFeature 1.23.0 peer has an upstream `EventEmitter<[never]>`
declaration conflict with `@types/node` 26.4.1. For this combination, use Node 24 types matching
your Node 24 application; Node 26 declaration compatibility is not claimed for the optional
provider. This does not affect users who install only the Flags runtime.
