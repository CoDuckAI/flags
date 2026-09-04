import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { OpenFeature } from "@openfeature/server-sdk";
import { bucketFor, defineRuleset } from "../../packages/core/dist/index.js";
import { createManagementClient } from "../../packages/management/dist/index.js";
import { createOpenFeatureProvider } from "../../packages/openfeature/dist/index.js";
import { createClient, fileCache, httpSource } from "../../packages/sdk/dist/index.js";
import { createFlagServer, FileRulesetStore } from "../../packages/server/dist/index.js";

const APP_PORT = Number(process.env.PORT ?? 5001);
const FLAG_PORT = Number(process.env.FLAG_PORT ?? 5002);
const READ_KEY = "proof-runtime-read-key-2026";
const ADMIN_KEY = "proof-management-key-2026";
const ENVIRONMENT = "proof";
const FLAG_KEY = "new-checkout";
const RULE_ID = "percentage-rollout";
const MARKER = "coduck-flags-browser-proof-v1";
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const stateDirectory = await mkdtemp(join(tmpdir(), "coduck-flags-browser-proof-"));
const storePath = join(stateDirectory, "rulesets.json");
const cachePath = join(stateDirectory, "runtime-cache.json");

function findAccount(predicate) {
  for (let index = 0; index < 100_000; index += 1) {
    const id = `account-${index}`;
    const bucket = bucketFor(id, FLAG_KEY, `${FLAG_KEY}:${RULE_ID}`);
    if (predicate(bucket)) return { id, bucket };
  }
  throw new Error("Could not find a deterministic proof account");
}

const accounts = {
  early: { name: "Maya · early cohort", ...findAccount((bucket) => bucket < 1_000) },
  expansion: {
    name: "Jordan · expansion cohort",
    ...findAccount((bucket) => bucket >= 2_500 && bucket < 5_000)
  },
  holdout: { name: "Alex · holdout", ...findAccount((bucket) => bucket >= 7_500) }
};

function initialRuleset() {
  return defineRuleset({
    schemaVersion: 1,
    revision: 1,
    environment: ENVIRONMENT,
    updatedAt: new Date().toISOString(),
    segments: {},
    flags: {
      [FLAG_KEY]: {
        type: "boolean",
        enabled: true,
        variations: { off: false, on: true },
        offVariation: "off",
        defaultVariation: "off",
        targets: [],
        rules: [{ id: RULE_ID, conditions: [], serve: { variation: "off" } }]
      }
    }
  });
}

let flagServer;
let flagUrl = `http://127.0.0.1:${FLAG_PORT}`;
let runtime;
let management;
let lastOperation = { kind: "boot", message: "Proof environment started from revision 1" };

async function startControlPlane() {
  if (flagServer) return;
  flagServer = createFlagServer({
    store: new FileRulesetStore(storePath),
    readKeys: [READ_KEY],
    adminKeys: [ADMIN_KEY],
    host: "127.0.0.1",
    port: FLAG_PORT,
    heartbeatMs: 100
  });
  const started = await flagServer.start();
  flagUrl = started.url;
  management = createManagementClient({ url: flagUrl, adminKey: ADMIN_KEY });
}

async function stopControlPlane() {
  if (!flagServer) return;
  const current = flagServer;
  flagServer = undefined;
  management = undefined;
  await current.stop();
}

async function resetEnvironment() {
  await OpenFeature.clearProviders();
  runtime = undefined;
  await stopControlPlane();
  await rm(storePath, { force: true });
  await rm(cachePath, { force: true });
  await new FileRulesetStore(storePath).put(initialRuleset(), null);
  await startControlPlane();
  runtime = createClient({
    environment: ENVIRONMENT,
    source: httpSource({
      url: flagUrl,
      environment: ENVIRONMENT,
      sdkKey: READ_KEY,
      pollIntervalMs: 250
    }),
    cache: fileCache(cachePath),
    staleAfterMs: 450
  });
  await runtime.waitUntilReady({ timeoutMs: 3_000 });
  await OpenFeature.setProviderAndWait(createOpenFeatureProvider(runtime));
  lastOperation = { kind: "reset", message: "Fresh revision 1 loaded through HTTP/SSE" };
}

function rolloutPercentage(ruleset) {
  const rule = ruleset.flags[FLAG_KEY]?.rules.find((candidate) => candidate.id === RULE_ID);
  if (rule?.serve.variation === "on") return 100;
  if (rule?.serve.variation === "off") return 0;
  return (rule?.serve.rollout?.splits.find((split) => split.variation === "on")?.weight ?? 0) / 100;
}

async function stateFor(accountId) {
  const known =
    Object.values(accounts).find((account) => account.id === accountId) ?? accounts.early;
  const context = { targetingKey: known.id, plan: "pro" };
  const details = runtime.evaluate(FLAG_KEY, context, { default: false });
  const openFeature = await OpenFeature.getClient().getBooleanDetails(FLAG_KEY, false, context);
  const ruleset = await new FileRulesetStore(storePath).get(ENVIRONMENT);
  return {
    marker: MARKER,
    sha: SHA,
    controlPlane: flagServer ? "connected" : "offline",
    runtime: runtime.getStatus(),
    account: known,
    accounts,
    rollout: ruleset ? rolloutPercentage(ruleset) : null,
    enabled: ruleset?.flags[FLAG_KEY]?.enabled ?? null,
    evaluation: details,
    openFeature: {
      value: openFeature.value,
      variant: openFeature.variant,
      reason: openFeature.reason,
      errorCode: openFeature.errorCode
    },
    lastOperation
  };
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) throw Object.assign(new Error("body too large"), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(text);
}

async function rawPublish(ruleset, key, expectedRevision) {
  return fetch(`${flagUrl}/v1/rulesets/${ENVIRONMENT}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "if-match": `"${expectedRevision}"`
    },
    body: JSON.stringify(ruleset)
  });
}

async function action(pathname, body) {
  if (pathname === "/api/reset") {
    await resetEnvironment();
    return { ok: true };
  }
  if (pathname === "/api/rollout") {
    if (!management) throw Object.assign(new Error("control plane offline"), { statusCode: 503 });
    const ruleset = await management.setBooleanRollout(FLAG_KEY, body.percentage, {
      environment: ENVIRONMENT
    });
    lastOperation = {
      kind: "rollout",
      message: `Rollout set to ${body.percentage}% at revision ${ruleset.revision}`
    };
    return { ok: true, revision: ruleset.revision };
  }
  if (pathname === "/api/enabled") {
    if (!management) throw Object.assign(new Error("control plane offline"), { statusCode: 503 });
    const ruleset = await management.setEnabled(ENVIRONMENT, FLAG_KEY, body.enabled);
    lastOperation = {
      kind: body.enabled ? "enabled" : "kill-switch",
      message: `${body.enabled ? "Kill switch released" : "Kill switch engaged"} at revision ${ruleset.revision}`
    };
    return { ok: true, revision: ruleset.revision };
  }
  if (pathname === "/api/target") {
    if (!management) throw Object.assign(new Error("control plane offline"), { statusCode: 503 });
    const ruleset = await management.setTarget(
      ENVIRONMENT,
      FLAG_KEY,
      body.targetingKey,
      body.variation
    );
    lastOperation = {
      kind: "target",
      message: `Exact target ${body.targetingKey} → ${body.variation} at revision ${ruleset.revision}`
    };
    return { ok: true, revision: ruleset.revision };
  }
  if (pathname === "/api/restart") {
    await stopControlPlane();
    await startControlPlane();
    await runtime.refresh();
    lastOperation = {
      kind: "restart",
      message: `Control plane restarted from the persisted store at revision ${runtime.getStatus().revision}`
    };
    return { ok: true };
  }
  if (pathname === "/api/stop") {
    await stopControlPlane();
    lastOperation = {
      kind: "outage",
      message: "Control plane stopped; the consumer remains online from memory"
    };
    return { ok: true };
  }
  if (pathname === "/api/start") {
    await startControlPlane();
    await runtime.refresh();
    lastOperation = {
      kind: "recovery",
      message: `Control plane recovered; revision ${runtime.getStatus().revision} confirmed`
    };
    return { ok: true };
  }
  if (pathname === "/api/read-key-write") {
    const current = await new FileRulesetStore(storePath).get(ENVIRONMENT);
    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    const result = await rawPublish(next, READ_KEY, current.revision);
    lastOperation = {
      kind: "read-key-rejected",
      message: `Runtime read key write rejected with HTTP ${result.status}`
    };
    return { ok: result.status === 401, status: result.status };
  }
  if (pathname === "/api/invalid") {
    const current = await new FileRulesetStore(storePath).get(ENVIRONMENT);
    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    next.flags[FLAG_KEY].rules = [
      {
        id: RULE_ID,
        conditions: [],
        serve: {
          rollout: {
            bucketBy: "targetingKey",
            salt: `${FLAG_KEY}:${RULE_ID}`,
            splits: [
              { variation: "on", weight: 2_500 },
              { variation: "off", weight: 2_500 }
            ]
          }
        }
      }
    ];
    const result = await rawPublish(next, ADMIN_KEY, current.revision);
    lastOperation = {
      kind: "invalid-rejected",
      message: `Malformed 5,000-point rollout rejected with HTTP ${result.status}`
    };
    return { ok: result.status === 400, status: result.status };
  }
  if (pathname === "/api/concurrency") {
    const current = await new FileRulesetStore(storePath).get(ENVIRONMENT);
    const first = structuredClone(current);
    const second = structuredClone(current);
    for (const [candidate, label] of [
      [first, "first"],
      [second, "second"]
    ]) {
      candidate.revision += 1;
      candidate.updatedAt = new Date().toISOString();
      candidate.flags[FLAG_KEY].metadata = { competingWriter: label };
    }
    const responses = await Promise.all([
      rawPublish(first, ADMIN_KEY, current.revision),
      rawPublish(second, ADMIN_KEY, current.revision)
    ]);
    const statuses = responses.map((response) => response.status).sort();
    const stored = await new FileRulesetStore(storePath).get(ENVIRONMENT);
    lastOperation = {
      kind: "concurrency",
      message: `Concurrent writers returned ${statuses.join(" + ")}; one revision ${stored.revision} survived`
    };
    return { ok: statuses[0] === 200 && statuses[1] === 409, statuses, revision: stored.revision };
  }
  throw Object.assign(new Error("unknown action"), { statusCode: 404 });
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CoDuck Flags · Live consumer proof</title>
  <style>
    :root { color-scheme: dark; --bg:#080b0d; --panel:#101519; --line:#263138; --ink:#eef7f4; --muted:#94a49f; --mint:#5ee0b4; --blue:#8cb8ff; --red:#ff746c; --amber:#f6c76d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 15% -10%,#18352f 0,transparent 38%),var(--bg); color:var(--ink); font:14px/1.45 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button { font:inherit; }
    .shell { width:min(1180px,calc(100% - 32px)); margin:0 auto; padding:28px 0 44px; }
    header { display:flex; align-items:center; gap:14px; margin-bottom:22px; }
    .logo { width:36px; height:36px; display:grid; place-items:center; border-radius:11px; background:var(--mint); color:#05251b; font-size:20px; box-shadow:0 0 34px #5ee0b433; }
    h1 { margin:0; font-size:18px; letter-spacing:-.02em; }
    .eyebrow { color:var(--muted); font-size:11px; letter-spacing:.1em; text-transform:uppercase; }
    .head-status { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .pill { display:inline-flex; align-items:center; gap:7px; padding:7px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:#0d1215cc; font-size:12px; }
    .dot { width:7px; height:7px; border-radius:50%; background:var(--mint); box-shadow:0 0 12px #5ee0b488; }
    .pill.stale .dot,.pill.offline .dot { background:var(--amber); box-shadow:none; }
    .grid { display:grid; grid-template-columns:1.15fr .85fr; gap:16px; }
    .panel { border:1px solid var(--line); border-radius:16px; background:linear-gradient(145deg,#11181c,#0c1114); box-shadow:0 18px 50px #0005; overflow:hidden; }
    .panel-head { padding:16px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .panel h2 { margin:0; font-size:14px; }
    .body { padding:18px; }
    .accounts { display:grid; grid-template-columns:repeat(3,1fr); gap:9px; margin-bottom:16px; }
    .account { cursor:pointer; text-align:left; min-height:72px; color:var(--muted); padding:11px; border-radius:11px; border:1px solid var(--line); background:#0b1013; transition:.16s ease; }
    .account:hover { border-color:#52635f; transform:translateY(-1px); }
    .account.active { color:var(--ink); border-color:var(--mint); background:#10221d; box-shadow:inset 0 0 0 1px #5ee0b422; }
    .account strong { display:block; font-size:12px; margin-bottom:4px; }
    .account span { font:11px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); }
    .feature { min-height:286px; padding:28px; border-radius:14px; display:flex; flex-direction:column; justify-content:space-between; position:relative; overflow:hidden; }
    .feature.new { background:linear-gradient(135deg,#dffff4,#bce9ff); color:#06281f; }
    .feature.classic { background:linear-gradient(135deg,#171f24,#101519); border:1px solid var(--line); color:var(--ink); }
    .feature .tag { align-self:flex-start; border:1px solid currentColor; border-radius:999px; padding:5px 8px; opacity:.65; font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
    .feature h3 { font-size:32px; line-height:1.05; letter-spacing:-.045em; margin:18px 0 8px; max-width:460px; }
    .feature p { margin:0; max-width:450px; opacity:.72; }
    .feature footer { display:flex; align-items:end; justify-content:space-between; gap:12px; margin-top:26px; }
    .reason { font:11px ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.66; }
    .cta { border:0; border-radius:10px; padding:10px 14px; color:white; background:#0b3e31; }
    .classic .cta { background:#29343a; }
    .controls { display:grid; gap:16px; }
    .section { border-top:1px solid var(--line); padding-top:15px; }
    .section:first-child { border:0; padding-top:0; }
    .section-title { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.1em; margin-bottom:9px; }
    .buttons { display:flex; flex-wrap:wrap; gap:8px; }
    .action { cursor:pointer; color:var(--ink); border:1px solid var(--line); background:#141b1f; border-radius:9px; padding:9px 11px; transition:.15s ease; }
    .action:hover { border-color:#63736f; background:#1a2428; }
    .action.primary { color:#05251b; background:var(--mint); border-color:var(--mint); font-weight:700; }
    .action.danger { color:#ffd4d1; border-color:#693b3a; background:#2a1718; }
    .action[disabled] { opacity:.45; cursor:wait; }
    .meter { margin-top:11px; height:7px; background:#20292e; border-radius:10px; overflow:hidden; }
    .meter > div { height:100%; width:0; background:linear-gradient(90deg,var(--mint),var(--blue)); transition:width .3s ease; }
    .details { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:16px; }
    .datum { border:1px solid var(--line); background:#0b1013; border-radius:10px; padding:10px; min-width:0; }
    .datum span { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.08em; }
    .datum strong { display:block; margin-top:4px; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .log { padding:12px 14px; margin-top:16px; border:1px solid var(--line); border-radius:11px; color:var(--muted); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .log b { color:var(--mint); }
    .proof-note { margin-top:14px; color:#667570; font-size:11px; }
    @media (max-width:800px) { .grid { grid-template-columns:1fr; } .head-status { display:none; } .feature { min-height:230px; } }
    @media (max-width:520px) { .shell { width:min(100% - 20px,1180px); padding-top:16px; } .accounts { grid-template-columns:1fr; } .account { min-height:54px; } .details { grid-template-columns:repeat(2,1fr); } .feature { padding:20px; } .feature h3 { font-size:27px; } }
  </style>
</head>
<body data-proof-build="${MARKER}">
  <main class="shell" data-testid="proof-app">
    <header>
      <div class="logo">⚑</div>
      <div><div class="eyebrow">real SDK consumer · proof surface</div><h1>CoDuck Flags rollout lab</h1></div>
      <div class="head-status">
        <span class="pill" id="source-pill" data-testid="source-status"><span class="dot"></span><span>connecting</span></span>
        <span class="pill" data-testid="revision-pill">revision <b id="revision">—</b></span>
        <span class="pill">OpenFeature <b id="of-status">—</b></span>
      </div>
    </header>
    <div class="grid">
      <section class="panel" data-testid="consumer-panel">
        <div class="panel-head"><div><div class="eyebrow">application read path</div><h2>What this account receives</h2></div><span class="pill">default <b>false</b></span></div>
        <div class="body">
          <div class="accounts" id="accounts"></div>
          <div id="feature-slot" data-testid="feature-slot"></div>
          <div class="details">
            <div class="datum"><span>account</span><strong id="account-id">—</strong></div>
            <div class="datum"><span>bucket</span><strong id="bucket">—</strong></div>
            <div class="datum"><span>variant</span><strong id="variant">—</strong></div>
            <div class="datum"><span>reason</span><strong id="reason">—</strong></div>
          </div>
          <div class="log" data-testid="operation-log"><b>event</b> <span id="operation">starting…</span></div>
          <p class="proof-note">This UI exists only to make the headless SDK observable. Every value comes from the built runtime package; controls call the built management SDK through the real reference server.</p>
        </div>
      </section>
      <aside class="panel" data-testid="management-panel">
        <div class="panel-head"><div><div class="eyebrow">management write path</div><h2>Release controls</h2></div><span class="pill"><b id="rollout-label">0%</b> rollout</span></div>
        <div class="body controls">
          <div class="section">
            <div class="section-title">Percentage ramp</div>
            <div class="buttons">
              <button class="action rollout" data-percentage="0">0%</button>
              <button class="action rollout" data-percentage="25">25%</button>
              <button class="action rollout" data-percentage="50">50%</button>
              <button class="action primary rollout" data-percentage="100" data-testid="rollout-100">100%</button>
            </div>
            <div class="meter"><div id="meter"></div></div>
          </div>
          <div class="section">
            <div class="section-title">Emergency control</div>
            <div class="buttons">
              <button class="action danger" id="kill" data-testid="kill-switch">Engage kill switch</button>
              <button class="action" id="enable">Release kill switch</button>
            </div>
          </div>
          <div class="section">
            <div class="section-title">Resilience</div>
            <div class="buttons">
              <button class="action" id="restart" data-testid="restart-control-plane">Restart control plane</button>
              <button class="action danger" id="stop" data-testid="stop-control-plane">Simulate outage</button>
              <button class="action" id="start" data-testid="start-control-plane">Recover source</button>
            </div>
          </div>
          <div class="section">
            <div class="section-title">Safety boundaries</div>
            <div class="buttons">
              <button class="action" id="read-key" data-testid="test-read-key">Try write with read key</button>
              <button class="action" id="invalid" data-testid="test-invalid">Publish invalid ruleset</button>
              <button class="action" id="concurrency" data-testid="test-concurrency">Race two writers</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </main>
  <script>
    let currentAccount;
    let busy = false;
    let latest;
    async function request(path, body = {}) {
      const response = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json()).error || 'request failed');
      return response.json();
    }
    async function refresh() {
      if (busy) return;
      try {
        const response = await fetch('/api/state?account=' + encodeURIComponent(currentAccount || ''));
        latest = await response.json();
        currentAccount ||= latest.accounts.early.id;
        render(latest);
      } catch {}
    }
    function render(state) {
      const source = document.getElementById('source-pill');
      const stale = state.runtime.stale;
      source.className = 'pill ' + (stale ? 'stale' : state.controlPlane === 'offline' ? 'offline' : '');
      source.querySelector('span:last-child').textContent = stale ? 'stale · last good active' : state.controlPlane;
      document.getElementById('revision').textContent = state.runtime.revision ?? '—';
      document.getElementById('of-status').textContent = state.openFeature.reason ?? '—';
      document.getElementById('rollout-label').textContent = state.rollout + '%';
      document.getElementById('meter').style.width = state.rollout + '%';
      document.getElementById('account-id').textContent = state.account.id;
      document.getElementById('bucket').textContent = state.account.bucket + ' / 9999';
      document.getElementById('variant').textContent = state.evaluation.variant ?? 'caller default';
      document.getElementById('reason').textContent = state.evaluation.reason;
      document.getElementById('operation').textContent = state.lastOperation.message;
      const accountsNode = document.getElementById('accounts');
      if (!accountsNode.children.length) {
        accountsNode.innerHTML = Object.values(state.accounts).map(account =>
          '<button class="account" data-account="'+account.id+'"><strong>'+account.name+'</strong><span>'+account.id+' · bucket '+account.bucket+'</span></button>'
        ).join('');
        accountsNode.querySelectorAll('[data-account]').forEach(button => button.onclick = () => { currentAccount=button.dataset.account; refresh(); });
      }
      accountsNode.querySelectorAll('[data-account]').forEach(button => button.classList.toggle('active', button.dataset.account===state.account.id));
      document.getElementById('feature-slot').innerHTML = state.evaluation.value
        ? '<article class="feature new" data-testid="new-checkout"><span class="tag">new experience</span><div><h3>Checkout, without the checkout line.</h3><p>The feature flag released this accelerated flow to the selected account.</p></div><footer><span class="reason">'+state.evaluation.reason+' · '+state.evaluation.variant+'</span><button class="cta">Continue instantly</button></footer></article>'
        : '<article class="feature classic" data-testid="classic-checkout"><span class="tag">current experience</span><div><h3>The reliable checkout.</h3><p>This account remains on the established path while the new experience rolls out safely.</p></div><footer><span class="reason">'+state.evaluation.reason+' · '+(state.evaluation.variant||'default')+'</span><button class="cta">Continue to checkout</button></footer></article>';
    }
    async function act(path, body) {
      busy=true; document.querySelectorAll('button').forEach(button=>button.disabled=true);
      try { await request(path, body); } finally { busy=false; document.querySelectorAll('button').forEach(button=>button.disabled=false); await refresh(); }
    }
    document.querySelectorAll('.rollout').forEach(button => button.onclick = () => act('/api/rollout',{percentage:Number(button.dataset.percentage)}));
    document.getElementById('kill').onclick=()=>act('/api/enabled',{enabled:false});
    document.getElementById('enable').onclick=()=>act('/api/enabled',{enabled:true});
    document.getElementById('restart').onclick=()=>act('/api/restart');
    document.getElementById('stop').onclick=()=>act('/api/stop');
    document.getElementById('start').onclick=()=>act('/api/start');
    document.getElementById('read-key').onclick=()=>act('/api/read-key-write');
    document.getElementById('invalid').onclick=()=>act('/api/invalid');
    document.getElementById('concurrency').onclick=()=>act('/api/concurrency');
    refresh(); setInterval(refresh,120);
  </script>
</body>
</html>`;

await resetEnvironment();

const app = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${APP_PORT}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-coduck-flags-proof": MARKER
      });
      response.end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/__proof") {
      sendJson(response, 200, { marker: MARKER, cwd: process.cwd(), sha: SHA });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, await stateFor(url.searchParams.get("account") ?? ""));
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      sendJson(response, 200, await action(url.pathname, await readBody(request)));
      return;
    }
    sendJson(response, 404, { error: "not found" });
  })().catch((error) => {
    sendJson(response, error.statusCode ?? 500, { error: error.message ?? String(error) });
  });
});

await new Promise((resolve, reject) => {
  app.once("error", reject);
  app.listen(APP_PORT, "127.0.0.1", resolve);
});

console.log(
  JSON.stringify({
    ready: true,
    app: `http://127.0.0.1:${APP_PORT}`,
    flags: flagUrl,
    marker: MARKER,
    sha: SHA,
    cwd: process.cwd(),
    stateDirectory
  })
);

async function shutdown() {
  await new Promise((resolve) => app.close(resolve));
  await OpenFeature.clearProviders();
  runtime = undefined;
  await stopControlPlane();
  await rm(stateDirectory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
