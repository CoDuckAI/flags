import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { assertRuleset, bucketFor, evaluateFlag, fnv1a32, validateRuleset } from "./index.js";
import type { Condition, EvaluationContext, JsonValue, Ruleset } from "./index.js";
import { fixtureRuleset, nextRevision } from "../../../tests/fixtures.js";

describe("ruleset validation", () => {
  it("accepts and deeply freezes a valid ruleset", () => {
    const ruleset = fixtureRuleset();
    expect(Object.isFrozen(ruleset)).toBe(true);
    expect(Object.isFrozen(ruleset.flags["new-agent"]?.rules)).toBe(true);
  });

  it("returns precise issues instead of throwing", () => {
    const input = structuredClone(fixtureRuleset()) as unknown as Record<string, unknown>;
    const flags = input.flags as Record<string, Record<string, unknown>>;
    const newAgent = flags["new-agent"]!;
    const rules = newAgent.rules as Array<Record<string, unknown>>;
    const serve = rules[1]!.serve as Record<string, unknown>;
    const rollout = serve.rollout as Record<string, unknown>;
    const splits = rollout.splits as Array<Record<string, unknown>>;
    splits[0]!.weight = 999;
    const result = validateRuleset(input);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("10000") })
      );
  });

  it("rejects unknown properties, unsafe keys and nested segments", () => {
    const input = structuredClone(fixtureRuleset()) as unknown as Record<string, unknown>;
    input.surprise = true;
    const segments = input.segments as Record<string, unknown>;
    segments.bad = { conditions: [{ attribute: "$segment", op: "in", value: ["internal"] }] };
    const result = validateRuleset(input);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("evaluation", () => {
  const cases: Array<{
    op: Condition["op"];
    actual?: JsonValue;
    expected?: JsonValue;
    matches: boolean;
  }> = [
    { op: "eq", actual: "pro", expected: "pro", matches: true },
    { op: "eq", actual: "free", expected: "pro", matches: false },
    { op: "eq", actual: { a: 1, b: 2 }, expected: { b: 2, a: 1 }, matches: true },
    { op: "neq", actual: "free", expected: "pro", matches: true },
    { op: "neq", expected: "pro", matches: false },
    { op: "in", actual: "pro", expected: ["pro", "team"], matches: true },
    { op: "in", actual: "free", expected: ["pro", "team"], matches: false },
    { op: "notIn", actual: "free", expected: ["pro", "team"], matches: true },
    { op: "notIn", expected: ["pro", "team"], matches: false },
    { op: "contains", actual: ["beta", "staff"], expected: "beta", matches: true },
    { op: "contains", actual: "hello world", expected: "world", matches: true },
    { op: "contains", actual: "hello", expected: "world", matches: false },
    { op: "notContains", actual: ["beta"], expected: "staff", matches: true },
    { op: "notContains", actual: 10, expected: "staff", matches: false },
    { op: "startsWith", actual: "org_123", expected: "org_", matches: true },
    { op: "startsWith", actual: "user_123", expected: "org_", matches: false },
    { op: "endsWith", actual: "a@example.com", expected: "@example.com", matches: true },
    { op: "endsWith", actual: "a@other.com", expected: "@example.com", matches: false },
    { op: "gt", actual: 11, expected: 10, matches: true },
    { op: "gt", actual: 10, expected: 10, matches: false },
    { op: "gte", actual: 10, expected: 10, matches: true },
    { op: "lt", actual: 9, expected: 10, matches: true },
    { op: "lte", actual: 10, expected: 10, matches: true },
    { op: "lte", actual: "10", expected: 10, matches: false },
    { op: "exists", actual: null, matches: true },
    { op: "exists", matches: false },
    { op: "notExists", matches: true },
    { op: "notExists", actual: null, matches: false }
  ];

  it.each(cases)(
    "evaluates $op with actual=$actual and expected=$expected",
    ({ op, actual, expected, matches }) => {
      const condition: Condition = {
        attribute: "attribute",
        op,
        ...(expected !== undefined ? { value: expected } : {})
      };
      const ruleset = nextRevision(fixtureRuleset(), (draft) => {
        draft.flags["new-agent"]!.targets = [];
        draft.flags["new-agent"]!.rules = [
          { id: "condition", conditions: [condition], serve: { variation: "on" } }
        ];
      });
      const context: EvaluationContext = { targetingKey: "account" };
      if (actual !== undefined) context.attribute = actual;
      expect(evaluateFlag(ruleset, "new-agent", context, false).value).toBe(matches);
    }
  );

  it("uses target, segment, split, default and disabled reasons in precedence order", () => {
    const ruleset = fixtureRuleset();
    expect(
      evaluateFlag(ruleset, "new-agent", { targetingKey: "account-vip" }, false)
    ).toMatchObject({ value: true, reason: "TARGETING_MATCH", variant: "on" });
    expect(
      evaluateFlag(ruleset, "new-agent", { targetingKey: "any", role: "staff" }, false)
    ).toMatchObject({ value: true, reason: "TARGETING_MATCH", ruleId: "internal-on" });
    expect(evaluateFlag(ruleset, "new-agent", { targetingKey: "ordinary" }, false).reason).toBe(
      "SPLIT"
    );
    expect(evaluateFlag(ruleset, "theme", {}, "classic")).toMatchObject({
      value: "midnight",
      reason: "DEFAULT"
    });
    const disabled = nextRevision(ruleset, (draft) => {
      draft.flags["new-agent"]!.enabled = false;
    });
    expect(
      evaluateFlag(disabled, "new-agent", { targetingKey: "account-vip" }, false)
    ).toMatchObject({ value: false, reason: "DISABLED" });
  });

  it("fails safely for missing flags, types and rollout keys", () => {
    const ruleset = fixtureRuleset();
    expect(evaluateFlag(ruleset, "missing", {}, true)).toMatchObject({
      value: true,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND"
    });
    expect(evaluateFlag(ruleset, "theme", {}, false)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH"
    });
    expect(evaluateFlag(ruleset, "new-agent", {}, false)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "TARGETING_KEY_MISSING"
    });
    expect(evaluateFlag(undefined, "new-agent", {}, true)).toMatchObject({
      value: true,
      reason: "ERROR",
      errorCode: "INVALID_CONFIGURATION"
    });
    expect(evaluateFlag(ruleset, "toString", {}, false)).toMatchObject({
      value: false,
      errorCode: "FLAG_NOT_FOUND"
    });
  });

  it("does not treat a missing attribute as matching negative conditions", () => {
    const base = fixtureRuleset();
    const ruleset = nextRevision(base, (draft) => {
      draft.flags["new-agent"]!.rules = [
        {
          id: "negative",
          conditions: [{ attribute: "country", op: "neq", value: "US" }],
          serve: { variation: "on" }
        }
      ];
    });
    expect(evaluateFlag(ruleset, "new-agent", { targetingKey: "a" }, false)).toMatchObject({
      value: false,
      reason: "DEFAULT"
    });
  });

  it("supports JSON flag values without sharing caller defaults", () => {
    const result = evaluateFlag(fixtureRuleset(), "limits", {}, { generations: 0 });
    expect(result).toMatchObject({ value: { generations: 10 }, variant: "standard" });
  });
});

describe("adversarial inputs", () => {
  it("never throws while validating arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => validateRuleset(value)).not.toThrow();
      }),
      { numRuns: 1_000 }
    );
  });

  it("never throws from evaluation even if a caller bypasses validation", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => evaluateFlag(value as unknown as Ruleset, "feature", {}, false)).not.toThrow();
      }),
      { numRuns: 1_000 }
    );
  });

  it("rejects unknown segment references", () => {
    const input = structuredClone(fixtureRuleset());
    input.flags["new-agent"]!.rules[0]!.conditions[0]!.value = ["typo"];
    const result = validateRuleset(input);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.issues.some((issue) => issue.message === "Unknown segment typo")).toBe(true);
  });
});

describe("bucketing", () => {
  it("pins UTF-8 FNV-1a golden values", () => {
    expect(fnv1a32("")).toBe(2166136261);
    expect(fnv1a32("hello")).toBe(1335831723);
    expect(fnv1a32("🦆")).toBe(169018636);
    expect(bucketFor("account-123", "new-agent", "v1")).toBe(508);
  });

  it("is deterministic for arbitrary unicode targeting keys", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (key, flag, salt) => {
        expect(bucketFor(key, flag, salt)).toBe(bucketFor(key, flag, salt));
      })
    );
  });

  it("keeps tuple boundaries unambiguous when inputs contain separators", () => {
    expect(bucketFor("a", "b", "c:d")).not.toBe(bucketFor("a:b", "c", "d"));
  });

  it("keeps the original cohort when a boolean rollout grows", () => {
    const base = fixtureRuleset();
    const twenty = nextRevision(base, (draft) => {
      const rollout = draft.flags["new-agent"]!.rules[1]!.serve.rollout!;
      rollout.splits = [
        { variation: "on", weight: 2000 },
        { variation: "off", weight: 8000 }
      ];
    });
    for (let index = 0; index < 20_000; index += 1) {
      const context = { targetingKey: `account-${index}` };
      const atTen = evaluateFlag(base, "new-agent", context, false).value;
      const atTwenty = evaluateFlag(twenty, "new-agent", context, false).value;
      if (atTen) expect(atTwenty).toBe(true);
    }
  });

  it("is approximately uniform", () => {
    let selected = 0;
    for (let index = 0; index < 100_000; index += 1) {
      if (bucketFor(`account-${index}`, "flag", "salt") < 2500) selected += 1;
    }
    expect(selected / 100_000).toBeGreaterThan(0.24);
    expect(selected / 100_000).toBeLessThan(0.26);
  });
});
