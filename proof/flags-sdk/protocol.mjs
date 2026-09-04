import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createClient, httpSource } from "../../packages/sdk/dist/index.js";
import { createFlagServer, MemoryRulesetStore } from "../../packages/server/dist/index.js";
import { booleanFlag, createManagementClient } from "../../packages/management/dist/index.js";

const directory = dirname(fileURLToPath(import.meta.url));
const results = [];
const readKey = "proof-read-key-123456789";
const adminKey = "proof-admin-key-12345678";
const ruleset = {
  schemaVersion: 1,
  revision: 1,
  environment: "proof",
  updatedAt: new Date().toISOString(),
  segments: {},
  flags: { feature: booleanFlag() }
};

function record(journey, step, predicate, note) {
  const pass = Boolean(predicate);
  results.push({ journey, step, pass, note });
  assert.ok(pass, `${journey}: ${step} (${note})`);
}

async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for an SDK state change");
}

const server = createFlagServer({
  store: new MemoryRulesetStore([ruleset]),
  readKeys: [readKey],
  adminKeys: [adminKey],
  heartbeatMs: 50
});
let flags;
let started;
let error;
const startedAt = new Date().toISOString();

try {
  started = await server.start();
  flags = createClient({
    environment: "proof",
    source: httpSource({
      url: started.url,
      environment: "proof",
      sdkKey: readKey,
      pollIntervalMs: 10_000
    }),
    staleAfterMs: 300
  });
  await flags.waitUntilReady();
  record(
    "initial-state",
    "The consumer loads the current production-style snapshot",
    flags.getStatus().revision === 1,
    `revision=${flags.getStatus().revision}`
  );
  record(
    "initial-state",
    "The feature is initially unavailable",
    flags.isEnabled("feature", { targetingKey: "account-123" }, { default: false }) === false,
    "defaultVariation=off"
  );

  const management = createManagementClient({ url: started.url, adminKey });
  const rolloutStart = performance.now();
  await management.setBooleanRollout("feature", 100, { environment: "proof" });
  await until(() => flags.getStatus().revision === 2);
  const rolloutMs = performance.now() - rolloutStart;
  record(
    "live-rollout",
    "A management SDK change reaches the running consumer without restart",
    flags.isEnabled("feature", { targetingKey: "account-123" }, { default: false }) === true,
    `revision=2, latency=${rolloutMs.toFixed(1)}ms`
  );
  record(
    "live-rollout",
    "Live delivery completes in under one second",
    rolloutMs < 1_000,
    `${rolloutMs.toFixed(1)}ms`
  );

  const unauthorized = await fetch(`${started.url}/v1/rulesets/proof`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${readKey}`,
      "content-type": "application/json",
      "if-match": '"2"'
    },
    body: JSON.stringify(ruleset)
  });
  record(
    "negative-access",
    "A runtime read key cannot modify flags",
    unauthorized.status === 401,
    `HTTP ${unauthorized.status}`
  );

  await management.setEnabled("proof", "feature", false);
  await until(() => flags.getStatus().revision === 3);
  record(
    "kill-switch",
    "The kill switch overrides the 100 percent rollout",
    flags.isEnabled("feature", { targetingKey: "account-123" }, { default: true }) === false,
    "revision=3, reason=DISABLED"
  );
  record(
    "kill-switch",
    "The SDK explains the disabled result",
    flags.evaluate("feature", { targetingKey: "account-123" }, { default: true }).reason ===
      "DISABLED",
    "reason=DISABLED"
  );

  await server.stop();
  await until(() => flags.getStatus().stale, 1_000);
  record(
    "source-failure",
    "The consumer detects that its configuration source is stale",
    flags.getStatus().stale,
    `revision=${flags.getStatus().revision}`
  );
  record(
    "source-failure",
    "Source failure preserves the last valid disabled value",
    flags.isEnabled("feature", { targetingKey: "account-123" }, { default: true }) === false,
    "The caller default is true, but the last valid false value remains active"
  );
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
} finally {
  await flags?.close();
  await server.stop();
}

const passed = results.filter((result) => result.pass).length;
const failed =
  results.filter((result) => !result.pass).length +
  (error && !results.some((result) => !result.pass) ? 1 : 0);
const report = {
  title: "CoDuck Flags SDK consumer proof",
  startedAt,
  finishedAt: new Date().toISOString(),
  scope: "Built SDK packages against the real embedded reference server over HTTP and SSE",
  limitations: [
    "This is a headless library; there is no browser UI or screenshot claim.",
    "This does not claim a CoDuck production integration, PR-environment application journey, npm publication, or multi-node control-plane availability."
  ],
  passed,
  failed,
  error,
  results
};

await mkdir(directory, { recursive: true });
await writeFile(join(directory, "protocol-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(
  join(directory, "PROTOCOL.md"),
  [
    "# CoDuck Flags SDK consumer proof",
    "",
    `**${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed.**`,
    "",
    `Run: ${startedAt}`,
    "",
    "The runner imports the built distribution packages and starts the actual reference server.",
    "Management changes travel through authenticated HTTP, and a separate runtime client receives them over SSE.",
    "No network mocks, fixture-only application mode, UI simulation, or fabricated recording is used.",
    "",
    "| Journey | Promise | Result | Evidence |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.journey} | ${result.step} | ${result.pass ? "PASS" : "FAIL"} | ${result.note} |`
    ),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    ...(error ? ["", "## Error", "", error] : []),
    "",
    "## Reproduce",
    "",
    "```bash",
    "pnpm build",
    "node proof/flags-sdk/protocol.mjs",
    "```",
    ""
  ].join("\n")
);
console.log(JSON.stringify({ passed, failed, report: join(directory, "PROTOCOL.md"), error }));
if (failed > 0) process.exitCode = 1;
