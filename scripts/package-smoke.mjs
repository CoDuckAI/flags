import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packages = [
  ["core", "defineRuleset"],
  ["sdk", "createClient"],
  ["management", "createManagementClient"],
  ["server", "createFlagServer"],
  ["openfeature", "createOpenFeatureProvider"]
];

for (const [directory, expectedExport] of packages) {
  const esm = await import(`../packages/${directory}/dist/index.js`);
  const cjs = require(`../packages/${directory}/dist/index.cjs`);
  assert.equal(typeof esm[expectedExport], "function", `${directory} ESM export`);
  assert.equal(typeof cjs[expectedExport], "function", `${directory} CJS export`);
}

console.log(JSON.stringify({ packages: packages.length, formats: ["esm", "cjs"], passed: true }));
