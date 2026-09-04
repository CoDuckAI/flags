import { performance } from "node:perf_hooks";
import { evaluateFlag } from "../packages/core/dist/index.js";

const ruleset = {
  schemaVersion: 1,
  revision: 1,
  environment: "benchmark",
  updatedAt: "2026-01-01T00:00:00.000Z",
  segments: {},
  flags: {
    enabled: {
      type: "boolean",
      enabled: true,
      variations: { off: false, on: true },
      offVariation: "off",
      defaultVariation: "on",
      targets: [],
      rules: []
    }
  }
};

const iterations = 1_000_000;
for (let index = 0; index < 10_000; index += 1) evaluateFlag(ruleset, "enabled", {}, false);
const start = performance.now();
let checksum = 0;
for (let index = 0; index < iterations; index += 1) {
  const result = evaluateFlag(ruleset, "enabled", {}, false);
  checksum += Number(result.value) + result.metadata.revision;
}
const elapsed = performance.now() - start;
const operationsPerSecond = Math.round(iterations / (elapsed / 1_000));
console.log(
  JSON.stringify({ iterations, elapsedMs: Math.round(elapsed), operationsPerSecond, checksum })
);
if (checksum !== iterations * 2) throw new Error("Benchmark evaluated an unexpected result");
if (operationsPerSecond < 500_000) process.exitCode = 1;
