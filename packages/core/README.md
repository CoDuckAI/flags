# `@coduck/flags-core`

The zero-dependency evaluation engine for CoDuck Flags. It validates versioned rulesets,
evaluates typed flags, matches ordered targeting rules and produces stable percentage
assignments without network access.

See the root [installation status](https://github.com/CoDuckAI/flags#install) during the initial
release. After npm publication: `npm install @coduck/flags-core`.

```ts
import { defineRuleset, evaluateBoolean } from "@coduck/flags-core";

const ruleset = defineRuleset(rawConfiguration);
const result = evaluateBoolean(
  ruleset,
  "new-checkout",
  { targetingKey: account.id, plan: account.plan },
  false
);

console.log(result.value, result.variant, result.reason, result.metadata.revision);
```

`defineRuleset()` throws with precise validation issues at configuration boundaries.
`evaluateFlag()` and the typed evaluators never throw; they return the caller default with an
error reason if evaluation cannot complete. Import the published JSON Schema from
`@coduck/flags-core/ruleset.schema.json`.

See the [v1 contract](https://github.com/CoDuckAI/flags/blob/main/SPEC.md) for evaluation order
and the normative bucketing algorithm.
