import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, "../..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const env = {
  ...process.env,
  PORT: process.env.PORT ?? "5001",
  FLAG_PORT: process.env.FLAG_PORT ?? "5002",
  ...(process.env.PROOF_CHROME ? {} : existsSync(chrome) ? { PROOF_CHROME: chrome } : {})
};

function run(script) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${script} exited with ${code ?? signal}`));
    });
  });
}

const server = spawn(process.execPath, ["proof/flags-sdk/demo-server.mjs"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "inherit"]
});

async function waitForServer() {
  let output = "";
  const timeout = setTimeout(() => server.kill("SIGTERM"), 10_000);
  for await (const chunk of server.stdout) {
    output += chunk.toString();
    const lines = output.split("\n");
    output = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
      try {
        const ready = JSON.parse(line);
        if (ready.ready) {
          clearTimeout(timeout);
          return ready;
        }
      } catch {
        // Non-JSON server diagnostics remain visible and are not readiness signals.
      }
    }
  }
  clearTimeout(timeout);
  throw new Error("proof consumer exited before becoming ready");
}

async function stopServer() {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

try {
  const ready = await waitForServer();
  const proof = await fetch(`${ready.app}/__proof`).then((response) => response.json());
  const cwd = execFileSync("lsof", ["-a", "-p", String(server.pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8"
  });
  if (
    !cwd.includes(`n${root}`) ||
    proof.cwd !== root ||
    proof.marker !== "coduck-flags-browser-proof-v1"
  ) {
    throw new Error(`wrong proof server: cwd=${proof.cwd} marker=${proof.marker}`);
  }
  console.log(
    `verified proof process ${server.pid} serves ${proof.marker} from ${proof.cwd} at ${proof.sha}`
  );
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const codeDirty = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "packages",
      "tests",
      "scripts",
      "package.json",
      "pnpm-lock.yaml",
      "proof/**/*.mjs"
    ],
    { cwd: root, encoding: "utf8" }
  ).trim();
  writeFileSync(
    resolve(folder, "source.json"),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        ...proof,
        pid: server.pid,
        codeDirty: Boolean(codeDirty),
        worktreeDirty: Boolean(dirty),
        processCwdVerified: true,
        scope:
          "Local real SDK consumer over authenticated HTTP/SSE with disk persistence; not a deployed CoDuck integration."
      },
      null,
      2
    ) + "\n"
  );
  await run("proof/flags-sdk/viewports.mjs");
  await run("proof/flags-sdk/run.mjs");
} finally {
  await stopServer();
}
