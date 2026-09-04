import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion, validateRelease } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.env.RELEASE_TAG ?? "";
const version = releaseVersion(tag);
const directory = join(root, "release", version);
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 120_000 });
assert.equal(process.env.GITHUB_ACTIONS, "true", "publish through the reviewed GitHub workflow");
assert.equal(process.env.GITHUB_REPOSITORY, "CoDuckAI/flags");
assert.ok(
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  "missing GitHub OIDC capability"
);
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
assert.equal(
  event.repository?.private,
  false,
  "public provenance requires a public source repository"
);
assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "source must remain clean");
const commit = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(run("git", ["rev-parse", `${tag}^{commit}`]).trim(), commit);
run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
const receipt = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const packages = validateRelease(receipt, directory, tag, commit);

for (const pkg of packages) {
  let existing;
  try {
    existing = JSON.parse(
      run("npm", [
        "view",
        `${pkg.name}@${version}`,
        "dist.integrity",
        "--json",
        "--registry=https://registry.npmjs.org",
        "--fetch-retries=0",
        "--fetch-timeout=15000"
      ])
    );
  } catch (error) {
    let detail;
    try {
      detail = JSON.parse(String(error.stdout));
    } catch {
      throw error;
    }
    if (detail.error?.code !== "E404") throw error;
  }
  if (existing) {
    assert.equal(
      existing,
      pkg.integrity,
      `${pkg.name}@${version} already exists with different bytes; do not overwrite or skip it`
    );
    console.log(`${pkg.name}@${version}: matching publication already exists`);
    continue;
  }
  console.log(`Publishing ${pkg.name}@${version}`);
  run("npm", [
    "publish",
    join(directory, pkg.filename),
    "--access",
    "public",
    "--provenance",
    "--tag",
    version.includes("-") ? "next" : "latest",
    "--registry=https://registry.npmjs.org"
  ]);
  const published = JSON.parse(
    run("npm", [
      "view",
      `${pkg.name}@${version}`,
      "dist.integrity",
      "--json",
      "--registry=https://registry.npmjs.org",
      "--fetch-retries=0",
      "--fetch-timeout=15000"
    ])
  );
  assert.equal(
    published,
    pkg.integrity,
    `${pkg.name}: published integrity does not match the release archive`
  );
}
console.log(`Verified all ${packages.length} npm publications for ${tag}`);
