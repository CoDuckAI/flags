import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const directories = ["core", "sdk", "management", "server", "openfeature", "test-vectors"];
const manifests = directories.map((directory) => ({
  directory,
  ...JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8"))
}));
const version = manifests[0].version;
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const temporary = mkdtempSync(join(tmpdir(), "coduck-flags-release-"));
const output = join(root, "release", version);
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
const packages = [];

try {
  for (const manifest of manifests) {
    assert.equal(manifest.version, version, "all SDK packages must use the same release version");
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.publishConfig.provenance, true);
    assert.equal(manifest.repository.url, "git+https://github.com/CoDuckAI/flags.git");
    const filename = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
    console.log(`Packing ${manifest.name}@${version}`);
    run("pnpm", [
      "--dir",
      `packages/${manifest.directory}`,
      "pack",
      "--pack-destination",
      temporary
    ]);
    const tarball = join(temporary, filename);
    const entries = run("tar", ["-tzf", tarball]).trim().split("\n");
    for (const entry of entries) {
      assert.ok(
        /^package\/(?:dist\/[^/]+|package\.json|README\.md|LICENSE|ruleset\.schema\.json|vectors\.json)$/.test(
          entry
        ),
        `unexpected package entry: ${entry}`
      );
    }
    assert.ok(entries.includes("package/LICENSE"), `${manifest.name}: missing license`);
    assert.ok(entries.includes("package/README.md"), `${manifest.name}: missing README`);
    const packed = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]));
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, version);
    assert.ok(
      !JSON.stringify(packed).includes("workspace:"),
      "published manifest contains workspace protocol"
    );
    for (const [name, dependency] of Object.entries(packed.dependencies ?? {})) {
      if (name.startsWith("@coduck/")) assert.equal(dependency, version);
    }
    if (manifest.directory !== "test-vectors") {
      for (const file of ["index.js", "index.cjs", "index.d.ts", "index.d.cts"]) {
        assert.ok(entries.includes(`package/dist/${file}`), `${manifest.name}: missing ${file}`);
      }
    }
    const archive = readFileSync(tarball);
    packages.push({
      name: manifest.name,
      version,
      filename,
      bytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      files: entries
    });
  }

  // No workspace symlinks: this consumer gets only the packed public files.
  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const openFeatureVersion = JSON.parse(
    readFileSync(join(root, "node_modules/@openfeature/server-sdk/package.json"), "utf8")
  ).version;
  console.log("Installing all six tarballs into an isolated consumer");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--fetch-retries=0",
      "--fetch-timeout=15000",
      ...packages.map((pkg) => join(temporary, pkg.filename)),
      `@openfeature/server-sdk@${openFeatureVersion}`
    ],
    consumer
  );

  for (const example of ["quickstart.mjs", "live-rollout.mjs"]) {
    copyFileSync(join(root, "examples", example), join(consumer, example));
    const result = run(process.execPath, [example], consumer);
    if (example === "quickstart.mjs") assert.match(result, /true TARGETING_MATCH pro-beta/);
    else {
      assert.match(result, /Before release: false/);
      assert.match(result, /After live release: true/);
      assert.match(result, /After kill switch: false/);
    }
    console.log(`${example}: passed from installed tarballs`);
  }

  const exports = [
    ["@coduck/flags-core", "defineRuleset"],
    ["@coduck/flags", "createClient"],
    ["@coduck/flags-management", "createManagementClient"],
    ["@coduck/flags-server", "createFlagServer"],
    ["@coduck/flags-openfeature", "createOpenFeatureProvider"]
  ];
  writeFileSync(
    join(consumer, "exports.cjs"),
    `const assert = require("node:assert/strict");\n` +
      exports
        .map(
          ([name, symbol]) =>
            `assert.equal(typeof require(${JSON.stringify(name)})[${JSON.stringify(symbol)}], "function");`
        )
        .join("\n") +
      '\nassert.ok(require("@coduck/flags-test-vectors"));\nassert.ok(require("@coduck/flags-core/ruleset.schema.json"));\n'
  );
  run(process.execPath, ["exports.cjs"], consumer);
  writeFileSync(
    join(consumer, "exports.mjs"),
    exports
      .map(
        ([name, symbol], index) =>
          `import { ${symbol} as symbol${index} } from ${JSON.stringify(name)}; if(typeof symbol${index} !== "function") throw new Error("missing ESM export");`
      )
      .join("\n")
  );
  run(process.execPath, ["exports.mjs"], consumer);

  copyFileSync(join(root, "examples/quickstart.mjs"), join(consumer, "quickstart.mts"));
  writeFileSync(
    join(consumer, "exports.mts"),
    exports
      .map(
        ([name, symbol], index) =>
          `import { ${symbol} as symbol${index} } from ${JSON.stringify(name)}; void symbol${index};`
      )
      .join("\n")
  );
  copyFileSync(join(consumer, "exports.mts"), join(consumer, "exports.cts"));
  run(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "quickstart.mts",
      "exports.mts",
      "exports.cts"
    ],
    consumer
  );

  mkdirSync(output, { recursive: true });
  for (const pkg of packages)
    copyFileSync(join(temporary, pkg.filename), join(output, pkg.filename));
  const receipt = {
    version,
    gitCommit: run("git", ["rev-parse", "HEAD"]).trim(),
    gitDirty: Boolean(run("git", ["status", "--porcelain"]).trim()),
    generatedAt: new Date().toISOString(),
    node: process.version,
    toolchain: {
      typescript: require("typescript/package.json").version,
      nodeTypes: require("@types/node/package.json").version,
      openFeature: openFeatureVersion
    },
    verified: {
      archiveContents: true,
      licenses: true,
      internalDependencies: true,
      isolatedInstall: true,
      esm: true,
      commonjs: true,
      typescript: true,
      quickstart: true,
      liveRollout: true
    },
    packages
  };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(
    join(output, "SHA256SUMS.txt"),
    packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}`).join("\n") + "\n"
  );
  console.log(JSON.stringify({ version, packages: packages.length, output, passed: true }));
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
