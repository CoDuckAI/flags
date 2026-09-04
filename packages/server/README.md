# `@coduck/flags-server`

An embeddable, single-node reference server for versioned CoDuck Flags rulesets. It is an
optional transport and persistence adapter—not a required hosted control plane. It exposes
authenticated snapshot, SSE stream and administrative publish endpoints.

See the root [installation status](https://github.com/CoDuckAI/flags#install) during the initial
release. After npm publication: `npm install @coduck/flags-server`.

```ts
import { createFlagServer, FileRulesetStore } from "@coduck/flags-server";

const server = createFlagServer({
  store: new FileRulesetStore("./data/flags.json"),
  readKeys: [process.env.FLAGS_SDK_KEY!],
  adminKeys: [process.env.FLAGS_ADMIN_KEY!],
  host: "127.0.0.1",
  port: 8080
});

const address = await server.start();
console.log(address.url);
```

Read and admin keys must be distinct and at least 16 characters. Put TLS and normal production
edge controls in front of the server. File persistence uses atomic replacement, but this
reference store is not a multi-node consensus system; larger deployments should implement the
`RulesetStore` interface on durable shared infrastructure.

See the [protocol contract](https://github.com/CoDuckAI/flags/blob/main/SPEC.md#delivery).
