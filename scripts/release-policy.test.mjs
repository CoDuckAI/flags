import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAMES, releaseVersion, validateRelease } from "./release-policy.mjs";

test("only explicit version tags can be released", () => {
  assert.equal(releaseVersion("v0.1.0"), "0.1.0");
  assert.equal(releaseVersion("v0.2.0-beta.1"), "0.2.0-beta.1");
  for (const tag of ["main", "../v0.1.0", "v0.1.0;echo", "v0.1", "v0.1.0\n"]) {
    assert.throws(() => releaseVersion(tag));
  }
});

test("local execution stops before reaching the npm publisher", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./publish.mjs", import.meta.url))],
    {
      env: { ...process.env, GITHUB_ACTIONS: "false", RELEASE_TAG: "v0.1.0" },
      encoding: "utf8",
      timeout: 5_000
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publish through the reviewed GitHub workflow/);
});

test("only complete, clean, verified and unchanged archives can publish", () => {
  const directory = mkdtempSync(join(tmpdir(), "flags-release-policy-"));
  try {
    const bytes = Buffer.from("fixture archive bytes");
    const receipt = {
      version: "0.1.0",
      gitCommit: "abc123",
      gitDirty: false,
      verified: Object.fromEntries(
        [
          "archiveContents",
          "licenses",
          "internalDependencies",
          "isolatedInstall",
          "esm",
          "commonjs",
          "typescript",
          "quickstart",
          "liveRollout"
        ].map((key) => [key, true])
      ),
      packages: PACKAGE_NAMES.map((name) => {
        const filename = `${name.replace(/^@/, "").replaceAll("/", "-")}-0.1.0.tgz`;
        writeFileSync(join(directory, filename), bytes);
        return {
          name,
          version: "0.1.0",
          filename,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
        };
      })
    };
    assert.equal(validateRelease(receipt, directory, "v0.1.0", "abc123").length, 6);
    assert.throws(() => validateRelease(receipt, directory, "v0.2.0", "abc123"));
    assert.throws(() => validateRelease(receipt, directory, "v0.1.0", "wrong-sha"));
    for (const mutate of [
      (value) => {
        value.gitDirty = true;
      },
      (value) => {
        value.verified.isolatedInstall = false;
      },
      (value) => {
        value.packages.pop();
      },
      (value) => {
        value.packages[0].filename = "../../other.tgz";
      },
      (value) => {
        value.packages[0].integrity = "sha512-changed";
      },
      (value) => {
        value.packages[0].sha256 = "changed";
      }
    ]) {
      const changed = structuredClone(receipt);
      mutate(changed);
      assert.throws(() => validateRelease(changed, directory, "v0.1.0", "abc123"));
    }
    writeFileSync(join(directory, receipt.packages[0].filename), "tampered");
    assert.throws(() => validateRelease(receipt, directory, "v0.1.0", "abc123"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
