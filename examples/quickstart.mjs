import { createClient, defineRuleset, staticSource } from "@coduckai/flags";

const ruleset = defineRuleset({
  schemaVersion: 1,
  revision: 1,
  environment: "production",
  updatedAt: new Date().toISOString(),
  segments: {},
  flags: {
    "new-checkout": {
      type: "boolean",
      enabled: true,
      variations: { off: false, on: true },
      offVariation: "off",
      defaultVariation: "off",
      targets: [],
      rules: [
        {
          id: "pro-beta",
          conditions: [{ attribute: "plan", op: "eq", value: "pro" }],
          serve: { variation: "on" }
        }
      ]
    }
  }
});

const flags = createClient({ source: staticSource(ruleset) });
await flags.waitUntilReady();

const result = flags.evaluate(
  "new-checkout",
  { targetingKey: "org_123", plan: "pro" },
  { default: false }
);

console.log(result.value, result.reason, result.ruleId);
// true TARGETING_MATCH pro-beta

await flags.close();
