import { describe, expect, it } from "vitest";
import vectors from "../packages/test-vectors/vectors.json" with { type: "json" };
import { bucketFor, fnv1a32 } from "../packages/core/src/index.js";

describe("published compatibility vectors", () => {
  it("match the implementation", () => {
    for (const vector of vectors.hash.vectors) expect(fnv1a32(vector.input)).toBe(vector.output);
    for (const vector of vectors.bucket.vectors) {
      expect(bucketFor(vector.targetingValue, vector.flagKey, vector.salt)).toBe(vector.output);
    }
  });
});
