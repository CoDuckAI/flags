import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../ruleset.schema.json" with { type: "json" };
import { fixtureRuleset } from "../../../tests/fixtures.js";

describe("published JSON Schema", () => {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    formats: { "date-time": true }
  });
  const validate = ajv.compile(schema);

  it("compiles and accepts the canonical fixture", () => {
    expect(validate(fixtureRuleset())).toBe(true);
  });

  it("rejects structural errors before semantic SDK validation", () => {
    const input = structuredClone(fixtureRuleset()) as unknown as Record<string, unknown>;
    input.revision = 0;
    input.unknown = true;
    expect(validate(input)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThanOrEqual(2);
  });
});
