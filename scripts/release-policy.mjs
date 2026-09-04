import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_NAMES = [
  "@coduck/flags-core",
  "@coduck/flags",
  "@coduck/flags-management",
  "@coduck/flags-server",
  "@coduck/flags-openfeature",
  "@coduck/flags-test-vectors"
];

export function releaseVersion(tag) {
  assert.equal(typeof tag, "string", "release tag must be a string");
  assert.equal(tag.trim(), tag, "release tag cannot contain surrounding whitespace");
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "release must be a version tag");
  return tag.slice(1);
}

export function validateRelease(receipt, directory, tag, commit) {
  const version = releaseVersion(tag);
  assert.equal(receipt.version, version, "manifest/tag version mismatch");
  assert.equal(receipt.gitCommit, commit, "manifest/source commit mismatch");
  assert.equal(receipt.gitDirty, false, "refusing a dirty-worktree release");
  for (const gate of [
    "archiveContents",
    "licenses",
    "internalDependencies",
    "isolatedInstall",
    "esm",
    "commonjs",
    "typescript",
    "quickstart",
    "liveRollout"
  ]) {
    assert.equal(receipt.verified?.[gate], true, `missing verification: ${gate}`);
  }
  assert.deepEqual(
    receipt.packages.map((pkg) => pkg.name).sort(),
    [...PACKAGE_NAMES].sort(),
    "release must contain exactly the six expected packages"
  );
  for (const pkg of receipt.packages) {
    assert.equal(pkg.version, version);
    const filename = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
    assert.equal(pkg.filename, filename, "unexpected archive filename");
    const bytes = readFileSync(join(directory, filename));
    assert.equal(bytes.length, pkg.bytes, `${pkg.name}: byte count mismatch`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      pkg.sha256,
      `${pkg.name}: checksum mismatch`
    );
    assert.equal(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      pkg.integrity,
      `${pkg.name}: integrity mismatch`
    );
  }
  return receipt.packages;
}
