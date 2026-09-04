# Target the right accounts

Start with one stable identity and trusted attributes:

```js
const context = {
  targetingKey: account.id, // authenticated account/organization ID
  plan: account.plan,
  country: account.country,
  beta: account.betaOptIn
};
```

These values come from your application; the SDK does not authenticate an account or look up
its plan. Every instance must use the same identity convention. An organization ID and a user
ID are different rollout units. `targetingKey` must be a string. For custom `bucketBy` attributes,
numeric `123` and string `"123"` are different bucket inputs.

## Evaluation order

1. Missing configuration, unknown flag or wrong type → caller default with an error.
2. Disabled flag → `offVariation`.
3. Exact targeting-key override.
4. First matching ordered rule, including its percentage split if present.
5. No matching rule → `defaultVariation`.

`enabled: true` permits normal evaluation; it does not mean “on for everyone.”
`enabled: false` bypasses all targets and rules and serves the configured off variation.

## Exact account overrides

With a management client connected as shown in the root README:

```js
await admin.setTarget("production", "new-checkout", "org_beta", "on");
await admin.setTarget("production", "new-checkout", "org_holdout", "off");
```

Overrides take priority over every targeting rule. Changing a 10% rollout to 100% does not
remove an explicit off override. An override never replaces your application's entitlement checks.

## Roll out to 25% of eligible accounts

Use the same conditions and rule ID on every update. This selects 25% of Pro beta accounts;
it does not select 25% of all accounts and then check their plan.

```js
const rolloutOptions = {
  environment: "production",
  ruleId: "pro-beta-rollout",
  conditions: [
    { attribute: "plan", op: "eq", value: "pro" },
    { attribute: "beta", op: "eq", value: true }
  ]
};

await admin.setBooleanRollout("new-checkout", 25, rolloutOptions);
await admin.setBooleanRollout("new-checkout", 50, rolloutOptions);
```

All conditions in a rule are ANDed. Multiple rules express OR in priority order. The helper
replaces the named rule's conditions; omitting them on a later call means no eligibility filter.
It appends a new rule after existing rules, so an earlier catch-all can prevent it from running.
Use `admin.update()` when you need to change rule ordering deliberately.

## Reusable segments

A ruleset can define a segment and reference it from several flags:

```js
const segments = {
  internal: {
    conditions: [{ attribute: "role", op: "in", value: ["staff", "tester"] }]
  }
};
```

Pass `segments` into the ruleset. The referencing rule's condition is:

```js
const condition = { attribute: "$segment", op: "in", value: ["internal"] };
```

Segments cannot reference other segments. The validator rejects unknown segment names.
See the [full ruleset types](../packages/core/src/types.ts) for the complete shape.

## Missing and mistyped attributes

Conditions do not coerce types: number `10` is not string `"10"`. A missing attribute does not
match a negative condition such as `neq` or `notIn`. Use `notExists` when absence is intentional.

For a rule that buckets by a missing identity attribute, evaluation returns the caller default
with `TARGETING_KEY_MISSING` rather than assigning all anonymous traffic to one shared bucket.

## Sticky does not mean permanent

Assignments remain stable for the same targeting value, flag key and salt. Keeping the on
variation first and expanding its split preserves the original cohort. Changing a targeting
value, salt, eligibility condition or earlier rule can change the result. Arbitrary multi-variant
boundary changes can reassign accounts.

Ruleset weights are integer basis points totaling 10,000. The management percentage helper
accepts 0 through 100 with at most two decimal places. Percentages are approximate identity
shares, not quotas or request-level traffic controls.

## Debug a decision

```js
const result = flags.evaluate("new-checkout", context, { default: false });
console.log({
  value: result.value,
  variant: result.variant,
  reason: result.reason,
  ruleId: result.ruleId,
  revision: result.metadata.revision,
  errorCode: result.errorCode
});
```

Check the revision first, then identity/attributes, then exact overrides, then rule order.
Avoid logging raw personal data. For evidence of actual product exposure, see the
[production guide](production.md#observability).
