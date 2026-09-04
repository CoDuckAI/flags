import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const examples = [
  ...readme.matchAll(
    /<!-- example: ([^\n]+) -->\s*```(?:js|ts)\n([\s\S]*?)\n```\s*<!-- \/example -->/g
  )
];
assert.ok(examples.length > 0, "README must contain a tested quickstart");
for (const [, file, code] of examples) {
  const source = readFileSync(resolve(root, file), "utf8");
  assert.equal(
    await format(code, { parser: "babel" }),
    await format(source, { parser: "babel" }),
    `${file} differs from its README example`
  );
  const output = execFileSync(process.execPath, [resolve(root, file)], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });
  assert.match(
    output,
    /true TARGETING_MATCH pro-beta/,
    "quickstart must produce its documented result"
  );
}
const files = ["README.md", "RELEASING.md", "docs/targeting.md", "docs/production.md"];
let links = 0;
for (const file of files) {
  const markdown = readFileSync(resolve(root, file), "utf8");
  for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    if (target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
    const localPath = target.split("#")[0];
    assert.ok(
      existsSync(resolve(root, dirname(file), localPath)),
      `${file}: broken link ${target}`
    );
    links++;
  }
}
console.log(
  JSON.stringify({ documentationExamples: examples.length, localLinks: links, passed: true })
);
