// /proof journey runner template.
// Copy into <feature>-journeys/ at your repo root as run.mjs (and copy
// report-template.mjs next to it as report.mjs). Adapt:
//  - BASE/PORT for your dev server
//  - freshUser() for your app's register/onboarding flow
//  - the JOURNEYS + PROMISES at the bottom for your feature's promises
//
// Contract: every step is rec()'d (assertion), every user-visible state is
// shot() (screenshot), report.json + REPORT.md + REPORT.html are written,
// exit is non-zero on any failure.
// Usage: node <feature>-journeys/run.mjs [--baseline] [--device=desktop] [journey1,journey2]
// The run is PACED for a human watching the recording (see PACE below);
// PROOF_PACE=fast collapses the pacing for CI, where nobody is watching.
//
// --baseline captures the BEFORE side of before/after pairs. Stand up the
// merge-base build on another port, then point the runner at it:
//   git worktree add /tmp/proof-base $(git merge-base HEAD origin/main)
//   (boot that checkout) && PORT=5002 node <feature>-journeys/run.mjs --baseline
// Baseline runs are capture-only: same journeys, same shot names, but
// assertions don't gate (the feature isn't supposed to exist yet), shots land
// in shots-baseline/, and no reports are written. Rerun without --baseline
// afterwards — the report writer pairs shots by journey + filename.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { writeReports } from "./report.mjs";

const PORT = process.env.PORT || "5001";
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const ARGS = process.argv.slice(2);
const BASELINE = ARGS.includes("--baseline");
const ROOT = path.join(FOLDER, BASELINE ? "shots-baseline" : "shots");
const ONLY = ARGS.find((a) => !a.startsWith("--"))?.split(",") ?? null;
// Device to record at. DESKTOP is the default — most web apps are used in a
// desktop browser, so that's the honest review surface. Use phone for a
// mobile-only app, or a ticket about a mobile/responsive/touch surface:
//   PROOF_DEVICE=phone node run.mjs   ·   node run.mjs --device=phone
const DEVICES = {
  phone: { width: 390, height: 844, dpr: 2 },
  desktop: { width: 1280, height: 800, dpr: 1 }
};
const DEVICE =
  process.env.PROOF_DEVICE ||
  ARGS.find((a) => a.startsWith("--device="))?.split("=")[1] ||
  "desktop";
const _DV = DEVICES[DEVICE] || DEVICES.phone;
const VIEWPORT = { width: _DV.width, height: _DV.height };
const DPR = _DV.dpr;
const results = [];
let browser;

// ── replay capture: screen-recorded video + input log → the REPORT.html player ─────────
// The run is RECORDED as a CLEAN screen video (no cursor baked in — a screen
// recording never captures one). Drive the UI through tap/fillIn/swipe/navTo/
// pause; each logs its target, its label, and the pointer's REAL sampled
// path to replay.json, and the player redraws a real cursor along that path
// on top of the video — so the overlay is honest, and can be toggled off.
// Off in --baseline runs, or with --no-replay when you only want the pass.
const REPLAY = !BASELINE && !ARGS.includes("--no-replay");
const replays = {};
const rp = (j) => (replays[j] ??= { t0: Date.now(), events: [], net: [], tracks: [] });

// ── surfaces: every tab and every session is its own recorded TRACK ──────────
// Playwright records EVERY page in a context, not just the one you opened. The
// harness used to bank only the page it knew about, which lost evidence two
// ways, both silently:
//   · a popup (target=_blank, window.open, an OAuth consent screen) had its
//     recording written to videos/ under a random hash and never claimed, and
//     its JS errors and network calls were invisible to the report;
//   · two sessions in one journey — a collab/permissions/second-device test —
//     both wrote videos/<journey>.webm, so the second clobbered the first.
// Every page is now adopted as a track the moment it opens, recorded under its
// own name, and its errors and traffic are attributed to it.
const TRACK = new WeakMap(); // page -> track
const CLOCKED = new Set(); // journeys whose clock has already started
/** Register a page as a track on this journey and wire its diagnostics. */
function openTrack(j, ctx, page, label) {
  const r = rp(j);
  // startedAt anchors this surface on the journey's clock: its recording
  // begins when the page opens, which is what lets the player run every
  // surface off ONE timeline instead of making you pick between them.
  const t = { id: r.tracks.length, label, ctx, page, video: null, startedAt: Date.now() - r.t0 };
  r.tracks.push(t);
  TRACK.set(page, t);
  const tag = t.id ? ` · ${label}` : "";
  page.on("pageerror", (e) => rec(j, `(pageerror${tag})`, false, e.message.slice(0, 140)));
  if (REPLAY)
    page.on("response", (res) => {
      const q = res.request();
      r.net.push({
        t: Date.now() - r.t0,
        ...(t.id ? { tr: t.id } : {}),
        method: q.method(),
        url: q.url().replace(BASE, "") || "/",
        status: res.status(),
        type: q.resourceType()
      });
    });
  return t;
}
const trackOf = (page) => (page && TRACK.get(page)) || null;

/** Log a replay event and RETURN it. Pass the page so the event is attributed
 *  to the surface it happened on — the player needs it to put the cursor on the
 *  right recording. Track 0 is left untagged so single-surface packs stay lean. */
const ev = (j, e, page) => {
  if (!REPLAY) return null;
  const t = trackOf(page);
  const o = { t: Date.now() - rp(j).t0, ...(t && t.id ? { tr: t.id } : {}), ...e };
  rp(j).events.push(o);
  return o;
};

// ── pacing: the recording has a HUMAN AUDIENCE ──────────────────────────────
// A reviewer watching this video does four things per action: find the cursor,
// follow it to the target, register the click, then find WHAT CHANGED. A flat
// delay serves none of them — it just makes an illegible run slow. So time is
// budgeted per BEAT: the cursor travels, comes to REST on the target (the eye
// needs a stationary target or it misses the consequence), the click lands, then
// the frame holds long enough to read the result.
//   travel → the pointer physically travels to the target over this
//   settle → it HOVERS on the target before pressing, so the hover state renders
//   press  → button held down, so :active renders
//   after  → the consequence stays on screen, readable
//   nav    → deliberately the longest: a navigation repaints the WHOLE screen
//            and the viewer has to re-orient from scratch
//   type   → per-character delay, so text is typed rather than pasted
// PROOF_PACE=fast collapses it all for CI runs nobody watches.
const PACE =
  process.env.PROOF_PACE === "fast"
    ? { travel: 0, settle: 0, press: 0, after: 120, nav: 150, type: 0 }
    : { travel: 550, settle: 260, press: 90, after: 700, nav: 1400, type: 45 };
const center = async (el) => {
  const box = await el.boundingBox().catch(() => null);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 };
};

// ── human pointer motion ────────────────────────────────────────────────────
// The single biggest reason a run doesn't "feel" like a person: locator.click()
// TELEPORTS the mouse to the target and presses in the same instant. Measured on
// a real app, that delivers ONE mousemove and ~2 frames of :hover — so hover
// states, focus rings and CSS transitions never render, and the recording is an
// inert app that suddenly changes state. Effects with no visible cause.
//
// So we drive the real pointer instead, the way a hand actually moves:
//   · a cubic Bézier bowed off the straight line — hands swoop, they don't rule
//     lines — with the bow's size and side varied per move
//   · a minimum-jerk velocity profile (10t³−15t⁴+6t⁵), the standard model of
//     human reaching: fast acceleration, long deceleration into the target
//   · duration scaled by distance à la Fitts's law, not a constant
// Every sample is logged, so the player redraws a REAL cursor along the REAL
// path — arrow while travelling, hand over a clickable target — instead of an
// invented straight line the pointer never took.
//
// Seeded, not random: reruns produce the same motion, so the pack stays
// reproducible while still looking hand-made.
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const seeds = {};
const seedOf = (j) => {
  let h = 0;
  for (let i = 0; i < j.length; i++) h = (Math.imul(h, 31) + j.charCodeAt(i)) | 0;
  seeds[j] = (seeds[j] || 0) + 1;
  return (h ^ Math.imul(seeds[j], 0x9e3779b1)) >>> 0;
};
/** Where the pointer currently rests, per page. Starts at the bottom centre —
 *  roughly where a hand sits before it reaches for something. */
const CURSOR = new WeakMap();
const restPoint = () => ({
  x: Math.round(VIEWPORT.width * 0.5),
  y: Math.round(VIEWPORT.height * 0.94)
});

/** Move the real pointer from wherever it is to `to`, like a hand would. */
async function glide(page, j, to, seed) {
  const from = CURSOR.get(page) || restPoint();
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  CURSOR.set(page, { x: to.x, y: to.y });
  if (!PACE.travel || d < 1.5) {
    await page.mouse.move(to.x, to.y);
    return;
  }
  const r = rng(seed);
  const ms = PACE.travel * (0.45 + 0.42 * Math.log2(1 + d / 55)); // Fitts-ish
  const steps = Math.max(14, Math.min(52, Math.round(ms / 15)));
  const uy0 = (to.y - from.y) / d,
    ux0 = (to.x - from.x) / d;
  const bow = d * (0.06 + 0.15 * r()) * (r() < 0.5 ? -1 : 1);
  const c1 = {
    x: from.x + (to.x - from.x) * 0.28 - uy0 * bow * 0.9,
    y: from.y + (to.y - from.y) * 0.28 + ux0 * bow * 0.9
  };
  const c2 = {
    x: from.x + (to.x - from.x) * 0.72 - uy0 * bow * 0.5,
    y: from.y + (to.y - from.y) * 0.72 + ux0 * bow * 0.5
  };
  // Long throws overshoot and get corrected — the ballistic + corrective phases
  // of real pointing. Short hops land directly, as they do for a person.

  const bez = (t) => {
    const m = 1 - t;
    return {
      x: m * m * m * from.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * to.x,
      y: m * m * m * from.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * to.y
    };
  };
  const jerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t); // minimum-jerk profile
  const path = [];
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const { x, y } = bez(jerk(i / steps));
    await page.mouse.move(x, y);
    if (REPLAY)
      path.push([Date.now() - rp(j).t0, Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    const lag = t0 + (ms * i) / steps - Date.now();
    if (lag > 1) await page.waitForTimeout(lag);
  }
  return path;
}
/** Travel to an element, then HOVER on it long enough for the app to react. */
async function reach(page, j, el) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const { x, y } = await center(el); // measured AFTER any scroll
  // What the OS cursor would actually have looked like over this element. A
  // screen recording never captures the cursor, so the player redraws one — and
  // it turns into a hand here only because the real one would have.
  const cur = await el.evaluate((n) => getComputedStyle(n).cursor).catch(() => "");
  const path = await glide(page, j, { x, y }, seedOf(j));
  await page.waitForTimeout(PACE.settle); // hover state renders, transition completes
  return { x, y, path, cur };
}
/** Press and release with the button actually held — so :active renders. */
async function press(page) {
  await page.mouse.down();
  await page.waitForTimeout(PACE.press);
  await page.mouse.up();
}
// `label` is not decoration — the player captions it ON the video as the action
// happens, so a viewer knows what to look for before the screen changes. Write
// it as the user's intent ('Start the focus block'), not as a selector.
/** Tap an element — real pointer travel, hover, then a held press. */
async function tap(page, j, selector, label = "") {
  const el = page.locator(selector).first();
  const { x, y, path, cur } = await reach(page, j, el);
  ev(j, { kind: "tap", x, y, label, path, cur }, page);
  await press(page);
  await page.waitForTimeout(PACE.after);
}
/** Type into a field — reach it, click in, then type character by character. */
async function fillIn(page, j, selector, text, label = "") {
  const el = page.locator(selector).first();
  const { x, y, path, cur } = await reach(page, j, el);
  ev(j, { kind: "fill", x, y, text, label, path, cur }, page);
  await press(page);
  await el.fill("");
  await page.waitForTimeout(PACE.press); // a beat after focusing, before typing
  // Typed, not pasted: fill() drops the whole string in a single frame, which
  // reads on video as a rendering glitch rather than as someone entering text.
  await el.pressSequentially(text, { delay: PACE.type });
  await page.waitForTimeout(PACE.after);
}
/** Drag/swipe between two viewport points — reach the start, then drag. */
async function swipe(page, j, [x, y], [x2, y2], label = "") {
  const path = (await glide(page, j, { x, y }, seedOf(j))) || [];
  await page.waitForTimeout(PACE.settle);
  // Logged at the START of the drag — the caption has to appear as the gesture
  // begins, not once it's already over.
  const e = ev(j, { kind: "swipe", x, y, x2, y2, label, path }, page);
  await page.mouse.down();
  await page.waitForTimeout(PACE.press);
  // The drag itself is a hand movement too — bow and ease it like any other.
  const drag = await glide(page, j, { x: x2, y: y2 }, seedOf(j));
  if (e) e.path = path.concat(drag || []);
  await page.mouse.up();
  await page.waitForTimeout(PACE.after);
}

/**
 * A step a machine physically can't perform — fingerprint/passkey, CAPTCHA,
 * OAuth consent, 3DS/OTP, a native OS dialog. NEVER fabricate a recording for
 * these. Instead:
 *   - pass a `stage` fn to apply its EFFECT via API/DB (headless/CI), so the
 *     journey continues and you can still assert the real outcome, or
 *   - run interactively (a TTY): the run pauses, you do it live in the browser,
 *     press Enter, and the recording captures the real thing.
 * Either way the step is logged as MANUAL and shown as manual in the report —
 * never blended into the machine-driven steps. Always rec() the OUTCOME after.
 */
async function manual(page, j, label, { stage } = {}) {
  const tty = process.stdin.isTTY && process.stdout.isTTY && !process.env.PROOF_MANUAL;
  const mode = stage ? "staged" : tty ? "human" : "skipped";
  ev(j, { kind: "manual", label, mode }, page);
  results.push({
    journey: j,
    step: label,
    status: "MANUAL",
    note:
      mode === "staged"
        ? "effect staged via API — a human performs this step in real use"
        : mode === "human"
          ? "performed by a human, live"
          : "manual step — not performed (run interactively or pass a stage fn)"
  });
  if (stage) {
    await stage();
  } else if (tty) {
    process.stdout.write(
      `\n   ⏸  MANUAL: ${label}\n      perform it in the browser, then press Enter to continue… `
    );
    await new Promise((res) => {
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.pause();
        res();
      });
    });
  } else {
    console.log(`   ⏸  MANUAL (unattended): ${label} — stage its effect or run interactively`);
  }
  await page.waitForTimeout(PACE.after);
}

/** Navigate, then HOLD — the whole screen just changed and the viewer has to
 *  re-orient from scratch. This is the longest beat in the budget for a reason:
 *  a navigation with no dwell is the single most disorienting cut in a run. */
async function navTo(page, j, url, label = "") {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // The pointer doesn't survive a document swap — put the hand back at rest so
  // the next reach starts from somewhere believable instead of the last target.
  CURSOR.delete(page);
  // Label this for a VIEWER ('back to the dashboard'), never a raw URL or query
  // string — the path is in the network log for whoever needs it.
  ev(j, { kind: "nav", label: label || url.replace(BASE, "") || "/" }, page);
  await page.waitForTimeout(PACE.nav);
}
/** Let the app run (timers, animations) — recorded in real time. */
async function pause(page, j, ms, label = "") {
  // Logged BEFORE the wait, not after: the caption has to say what's happening
  // DURING the pause ('block completes'), or the longest stretches of the run
  // are the ones with nothing on screen explaining them.
  ev(j, { kind: "wait", label: label || `${ms}ms` }, page);
  await page.waitForTimeout(ms);
}
/**
 * Close a session and bank the screen recording of EVERY page it opened — the
 * session itself plus any popup it spawned. The first track of a journey keeps
 * the familiar videos/<journey>.webm; extra surfaces get -2, -3, … so nothing
 * can overwrite anything.
 */
async function closeSession(s, j) {
  const mine = rp(j).tracks.filter((t) => t.ctx === s.ctx);
  const pending = REPLAY ? mine.map((t) => ({ t, v: t.page.video() })) : [];
  await s.ctx.close(); // finalises every video in the context
  for (const { t, v } of pending) {
    if (!v) continue;
    fs.mkdirSync(path.join(FOLDER, "videos"), { recursive: true });
    const rel = `videos/${j}${t.id ? "-" + (t.id + 1) : ""}.webm`;
    const clash = rp(j).tracks.find((o) => o !== t && o.video === rel);
    if (clash) {
      // Can't happen while ids are unique — but silent evidence loss is exactly
      // the bug this replaced, so refuse to do it quietly ever again.
      rec(j, `(recording clash: ${rel})`, false, `tracks ${clash.id} and ${t.id} both claim it`);
      continue;
    }
    await v.saveAs(path.join(FOLDER, rel));
    await v.delete().catch(() => {});
    t.video = rel;
  }
}

/**
 * Any .webm left in videos/ that no track claimed is a recording the harness
 * FAILED to attach — a surface it never noticed. Empty ones are Playwright
 * stubs and get removed; anything with bytes in it is real evidence going
 * unreferenced, so say so loudly rather than shipping a mystery file in the pack.
 */
function sweepVideos() {
  const dirPath = path.join(FOLDER, "videos");
  if (!fs.existsSync(dirPath)) return;
  const claimed = new Set(
    Object.values(replays).flatMap((r) =>
      r.tracks.map((t) => t.video && path.basename(t.video)).filter(Boolean)
    )
  );
  for (const f of fs.readdirSync(dirPath).filter((f) => f.endsWith(".webm"))) {
    if (claimed.has(f)) continue;
    const abs = path.join(dirPath, f);
    const size = fs.statSync(abs).size;
    if (size === 0) fs.rmSync(abs, { force: true });
    else
      console.log(
        `   ⚠ unclaimed recording videos/${f} (${size}B) — a surface the harness never adopted`
      );
  }
}

// ── harness ─────────────────────────────────────────────────────────────────
function dir(j) {
  const d = path.join(ROOT, j);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/**
 * Record one asserted step. Every claim in the report goes through here.
 *
 * `step` is read aloud on the video as a caption, so write it as a PLAIN
 * SENTENCE a stranger could follow — 'the timer is counting down', not
 * 'running: elapsed < 4000'. Put the technical predicate in `note`, which is
 * exactly what the ledger shows it for.
 *
 * `at` is the LOCATOR THAT PROVES IT (optional). The cursor marks the cause —
 * where you clicked. `at` marks the EFFECT: the player outlines that region as
 * the assertion fires. What changed is usually nowhere near what you clicked,
 * and that gap is why a run is hard to follow. Pass it and `await rec(...)`:
 *
 *   await rec(j, 'break block is queued', mode === 'break', mode, page.locator('[data-testid="mode-chip"]'));
 *
 * The box is measured at assertion time, so it must be awaited to be accurate.
 * Without `at`, rec() stays synchronous and awaiting it is a harmless no-op.
 */
function rec(j, step, ok, note = "") {
  results.push({ journey: j, step, status: ok ? "PASS" : "FAIL", note });
  ev(j, { kind: "assert", status: ok ? "PASS" : "FAIL", label: step });
  if (!ok) console.log(`   ✗ ${j} :: ${step} ${note ? "— " + note : ""}`);
}
/** Numbered screenshot of the current user-visible state. */
async function shot(page, j, idx, name) {
  await page.waitForTimeout(800); // let animations/images settle
  await page.screenshot({
    path: path.join(dir(j), String(idx).padStart(2, "0") + "-" + name + ".png"),
    fullPage: false
  });
  ev(j, { kind: "shot", label: name }, page);
}
// ── app-specific: isolated browser session against a freshly reset environment ──
async function freshSession(j, name) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    ...(REPLAY ? { recordVideo: { dir: path.join(FOLDER, "videos"), size: VIEWPORT } } : {})
  });
  // Baseline captures drive a build where the feature may not exist — fail
  // fast on missing surfaces instead of hanging on the default 30s timeout.
  // (Prefer count()-guarded lookups in journeys so baseline runs reach every
  // shot; see the demo for the pattern.)
  if (BASELINE) ctx.setDefaultTimeout(4000);
  // ONE clock per journey, started with the first recording. It used to be reset
  // by every freshUser() call, which rebased the timeline mid-journey and left
  // everything already logged pointing at the wrong moment.
  if (REPLAY && !CLOCKED.has(j)) {
    rp(j).t0 = Date.now();
    CLOCKED.add(j);
  }
  // Adopt every page this context opens — including ones the app opens itself:
  // target="_blank", window.open, an OAuth consent popup. Playwright is already
  // recording them; this is what claims the recording and wires up diagnostics.
  let opened = 0;
  ctx.on("page", (p) => {
    if (TRACK.has(p)) return;
    opened++;
    openTrack(j, ctx, p, opened === 1 ? name || "session" : `popup ${opened - 1}`);
  });
  const page = await ctx.newPage();
  if (!TRACK.has(page)) openTrack(j, ctx, page, name || "session"); // belt and braces
  const reset = await ctx.request.post(`${BASE}/api/reset`, { data: {} });
  if (!reset.ok()) throw new Error(`proof reset failed with HTTP ${reset.status()}`);
  return { ctx, page, name };
}

async function waitForText(page, selector, expected, timeout = 4_000) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected },
    { timeout }
  );
}

async function visible(page, selector) {
  return page
    .locator(selector)
    .isVisible()
    .catch(() => false);
}

async function instrumentRolloutLatency(page) {
  await page.evaluate(() => {
    window.__rolloutClickAt = 0;
    window.__rolloutVisibleAt = 0;
    document.querySelector('[data-percentage="25"]')?.addEventListener(
      "click",
      () => {
        window.__rolloutClickAt = performance.now();
      },
      { once: true }
    );
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="new-checkout"]') && !window.__rolloutVisibleAt) {
        window.__rolloutVisibleAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.querySelector('[data-testid="feature-slot"]'), {
      childList: true,
      subtree: true
    });
  });
}

// ── journeys: one per promise the SDK makes to an application team ─────────
const JOURNEYS = {};
const J = (name, fn) => (JOURNEYS[name] = fn);

const PROMISES = {
  "01-live-rollout":
    "A running application receives a percentage rollout live, without restarting or evaluating over the network.",
  "02-sticky-exclusion":
    "A percentage rollout includes an early cohort while a holdout remains excluded.",
  "02a-unselected-cohort":
    "An account outside the percentage boundary remains on the established experience.",
  "02b-sticky-expansion":
    "Expanding a rollout admits the next cohort without removing the original cohort.",
  "03-kill-switch": "The kill switch overrides even a 100% rollout immediately.",
  "04-persistence": "A published rollout survives a full control-plane restart.",
  "05-outage-recovery":
    "An outage marks configuration stale while the last valid value remains active, then recovers.",
  "06-safety-boundaries":
    "Read credentials, malformed rulesets, and stale concurrent writers cannot corrupt the active revision."
};

J("01-live-rollout", async () => {
  const j = "01-live-rollout";
  const a = await freshSession(j, "release manager");
  await navTo(a.page, j, `${BASE}/`, "the release manager opens the live rollout lab");
  await waitForText(a.page, "#revision", "1");
  rec(
    j,
    "the running consumer starts on revision 1",
    (await a.page.locator("#revision").textContent()) === "1",
    "revision 1"
  );
  rec(
    j,
    "the early-cohort account starts on the established checkout",
    await visible(a.page, '[data-testid="classic-checkout"]'),
    "caller default is false; configured variant is off"
  );
  rec(
    j,
    "the application reports a connected source",
    (await a.page.locator('[data-testid="source-status"]').textContent()).includes("connected"),
    "HTTP snapshot and SSE stream are live"
  );
  await shot(a.page, j, 1, "before-rollout");

  await instrumentRolloutLatency(a.page);
  await tap(
    a.page,
    j,
    '[data-percentage="25"]',
    "the release manager ramps the feature to 25 percent"
  );
  await waitForText(a.page, "#revision", "2");
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  const latency = await a.page.evaluate(() => window.__rolloutVisibleAt - window.__rolloutClickAt);
  rec(
    j,
    "the running consumer advances to revision 2 without a restart",
    (await a.page.locator("#revision").textContent()) === "2",
    "revision 2 arrived over the live source"
  );
  rec(
    j,
    "the selected account receives the new checkout",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "variant on"
  );
  rec(
    j,
    "the live UI update completes in under one second",
    latency > 0 && latency < 1_000,
    `${latency.toFixed(1)}ms from click to rendered SDK result`
  );
  rec(
    j,
    "the SDK explains the result as a percentage split",
    (await a.page.locator("#reason").textContent()) === "SPLIT",
    "core reason SPLIT"
  );
  rec(
    j,
    "the OpenFeature provider returns the same split result",
    (await a.page.locator("#of-status").textContent()) === "SPLIT",
    "provider reason SPLIT"
  );
  await shot(a.page, j, 2, "live-rollout-visible");
  await closeSession(a, j);
});

J("02-sticky-exclusion", async () => {
  const j = "02-sticky-exclusion";
  const a = await freshSession(j, "cohort reviewer");
  await navTo(a.page, j, `${BASE}/`, "the reviewer opens a fresh rollout");
  await waitForText(a.page, "#revision", "1");
  await tap(a.page, j, '[data-percentage="25"]', "the reviewer starts a 25 percent rollout");
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  rec(
    j,
    "the early cohort is included at 25 percent",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "bucket is below 2500"
  );
  await shot(a.page, j, 1, "early-cohort-included");

  await tap(
    a.page,
    j,
    'button:has-text("Alex · holdout")',
    "the reviewer checks a holdout account"
  );
  await waitForText(a.page, ".account.active", "Alex · holdout");
  await a.page.locator('[data-testid="classic-checkout"]').waitFor();
  rec(
    j,
    "the holdout account does not receive the unreleased checkout",
    !(await visible(a.page, '[data-testid="new-checkout"]')),
    "high bucket remains excluded"
  );
  rec(
    j,
    "the holdout stays on the established checkout",
    await visible(a.page, '[data-testid="classic-checkout"]'),
    "variant off"
  );
  await shot(a.page, j, 2, "holdout-excluded");

  await closeSession(a, j);
});

J("02a-unselected-cohort", async () => {
  const j = "02a-unselected-cohort";
  const a = await freshSession(j, "unselected cohort reviewer");
  const staged = await a.ctx.request.post(`${BASE}/api/rollout`, { data: { percentage: 25 } });
  if (!staged.ok()) throw new Error(`initial rollout failed with HTTP ${staged.status()}`);
  await navTo(a.page, j, `${BASE}/`, "the reviewer opens an existing 25 percent rollout");
  await tap(
    a.page,
    j,
    'button:has-text("Jordan · expansion cohort")',
    "the reviewer checks an account outside the boundary"
  );
  await waitForText(a.page, ".account.active", "Jordan · expansion cohort");
  await a.page.locator('[data-testid="classic-checkout"]').waitFor();
  rec(
    j,
    "the unselected cohort remains on the established checkout",
    await visible(a.page, '[data-testid="classic-checkout"]'),
    "bucket is between 2500 and 4999"
  );
  await shot(a.page, j, 1, "unselected-cohort-excluded");
  await closeSession(a, j);
});

J("02b-sticky-expansion", async () => {
  const j = "02b-sticky-expansion";
  const a = await freshSession(j, "expansion reviewer");
  const staged = await a.ctx.request.post(`${BASE}/api/rollout`, { data: { percentage: 25 } });
  if (!staged.ok()) throw new Error(`initial rollout failed with HTTP ${staged.status()}`);
  await navTo(a.page, j, `${BASE}/`, "the reviewer opens an existing 25 percent rollout");
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  rec(
    j,
    "the original cohort is already included",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "25 percent rollout; early account selected"
  );
  await shot(a.page, j, 1, "original-cohort-before-expansion");
  await tap(
    a.page,
    j,
    'button:has-text("Jordan · expansion cohort")',
    "the reviewer checks the next cohort before expanding"
  );
  await waitForText(a.page, ".account.active", "Jordan · expansion cohort");
  await a.page.locator('[data-testid="classic-checkout"]').waitFor();
  rec(
    j,
    "the next cohort is initially excluded",
    await visible(a.page, '[data-testid="classic-checkout"]'),
    "same account is off at 25 percent"
  );
  await shot(a.page, j, 2, "next-cohort-before-expansion");
  await tap(
    a.page,
    j,
    '[data-percentage="50"]',
    "the reviewer expands the same rollout to 50 percent"
  );
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  rec(
    j,
    "the expansion cohort joins at 50 percent",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "the same identity now falls inside the enlarged boundary"
  );
  await shot(a.page, j, 3, "next-cohort-admitted");
  await tap(
    a.page,
    j,
    'button:has-text("Maya · early cohort")',
    "the reviewer rechecks the original cohort"
  );
  await waitForText(a.page, ".account.active", "Maya · early cohort");
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  rec(
    j,
    "the original cohort remains included after the ramp grows",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "no previously selected account moved backward"
  );
  await shot(a.page, j, 4, "original-cohort-retained");
  await closeSession(a, j);
});

J("03-kill-switch", async () => {
  const j = "03-kill-switch";
  const a = await freshSession(j, "incident commander");
  await navTo(a.page, j, `${BASE}/`, "the incident commander opens release controls");
  await waitForText(a.page, "#revision", "1");
  await tap(a.page, j, '[data-testid="rollout-100"]', "the feature is released to every account");
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  rec(
    j,
    "the feature is visible during a 100 percent rollout",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "revision 2 serves on"
  );
  await shot(a.page, j, 1, "before-kill-switch");
  await tap(
    a.page,
    j,
    '[data-testid="kill-switch"]',
    "the incident commander engages the kill switch"
  );
  await a.page.locator('[data-testid="classic-checkout"]').waitFor();
  await waitForText(a.page, "#reason", "DISABLED");
  rec(
    j,
    "the new checkout disappears immediately",
    !(await visible(a.page, '[data-testid="new-checkout"]')),
    "kill switch overrides the rollout"
  );
  rec(
    j,
    "the safe checkout replaces it",
    await visible(a.page, '[data-testid="classic-checkout"]'),
    "off variation is active"
  );
  rec(
    j,
    "the SDK reports the disabled reason at revision 3",
    (await a.page.locator("#reason").textContent()) === "DISABLED" &&
      (await a.page.locator("#revision").textContent()) === "3",
    "reason DISABLED; revision 3"
  );
  rec(
    j,
    "OpenFeature also reports the disabled result",
    (await a.page.locator("#of-status").textContent()) === "DISABLED",
    "provider parity"
  );
  await shot(a.page, j, 2, "kill-switch-active");
  await closeSession(a, j);
});

J("04-persistence", async () => {
  const j = "04-persistence";
  const a = await freshSession(j, "platform operator");
  await navTo(a.page, j, `${BASE}/`, "the operator prepares a persisted rollout");
  await waitForText(a.page, "#revision", "1");
  await tap(a.page, j, '[data-percentage="50"]', "the operator publishes a 50 percent rollout");
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  rec(
    j,
    "revision 2 serves the selected cohort before restart",
    (await a.page.locator("#revision").textContent()) === "2" &&
      (await visible(a.page, '[data-testid="new-checkout"]')),
    "50 percent rollout stored on disk"
  );
  await shot(a.page, j, 1, "before-control-plane-restart");
  await tap(
    a.page,
    j,
    '[data-testid="restart-control-plane"]',
    "the operator restarts the entire control plane"
  );
  await waitForText(a.page, "#operation", "restarted from the persisted store");
  await waitForText(a.page, '[data-testid="source-status"]', "connected");
  rec(
    j,
    "the restarted control plane loads the same revision 2",
    (await a.page.locator("#revision").textContent()) === "2",
    "file-backed store retained the complete snapshot"
  );
  rec(
    j,
    "the account keeps the same assigned experience after restart",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "stable identity and salt preserve assignment"
  );
  rec(
    j,
    "the runtime reconnects to a healthy live source",
    !(await a.page.locator('[data-testid="source-status"]').textContent()).includes("stale"),
    "source connected"
  );
  await shot(a.page, j, 2, "persisted-after-restart");
  await closeSession(a, j);
});

J("05-outage-recovery", async () => {
  const j = "05-outage-recovery";
  const a = await freshSession(j, "reliability engineer");
  await navTo(a.page, j, `${BASE}/`, "the engineer starts from a healthy consumer");
  await waitForText(a.page, "#revision", "1");
  await tap(
    a.page,
    j,
    '[data-testid="rollout-100"]',
    "the engineer releases the feature before simulating failure"
  );
  await a.page.locator('[data-testid="new-checkout"]').waitFor();
  await tap(
    a.page,
    j,
    '[data-testid="stop-control-plane"]',
    "the engineer stops the configuration source"
  );
  await waitForText(a.page, '[data-testid="source-status"]', "stale · last good active", 5_000);
  rec(
    j,
    "the runtime explicitly reports stale configuration",
    (await a.page.locator('[data-testid="source-status"]').textContent()).includes("stale"),
    "staleAfterMs elapsed with source offline"
  );
  rec(
    j,
    "the last valid new checkout remains active during the outage",
    await visible(a.page, '[data-testid="new-checkout"]'),
    "caller default is false, proving this is the retained true value"
  );
  rec(
    j,
    "the active revision remains 2 instead of resetting",
    (await a.page.locator("#revision").textContent()) === "2",
    "last-known-good revision retained"
  );
  rec(
    j,
    "OpenFeature exposes the stale state",
    (await a.page.locator("#of-status").textContent()) === "STALE",
    "provider reason STALE"
  );
  await shot(a.page, j, 1, "offline-last-good-active");
  await tap(
    a.page,
    j,
    '[data-testid="start-control-plane"]',
    "the engineer restores the configuration source"
  );
  await waitForText(a.page, '[data-testid="source-status"]', "connected", 5_000);
  rec(
    j,
    "the runtime returns to a healthy connected state",
    !(await a.page.locator('[data-testid="source-status"]').textContent()).includes("stale"),
    "source recovered"
  );
  rec(
    j,
    "recovery keeps revision 2 and the same feature value",
    (await a.page.locator("#revision").textContent()) === "2" &&
      (await visible(a.page, '[data-testid="new-checkout"]')),
    "no configuration regression"
  );
  await shot(a.page, j, 2, "source-recovered");
  await closeSession(a, j);
});

J("06-safety-boundaries", async () => {
  const j = "06-safety-boundaries";
  const a = await freshSession(j, "security reviewer");
  await navTo(a.page, j, `${BASE}/`, "the reviewer opens the safety controls");
  await waitForText(a.page, "#revision", "1");
  await tap(
    a.page,
    j,
    '[data-testid="test-read-key"]',
    "the reviewer attempts a write with the runtime read key"
  );
  await waitForText(a.page, "#operation", "HTTP 401");
  rec(
    j,
    "a runtime read key cannot mutate configuration",
    (await a.page.locator("#operation").textContent()).includes("HTTP 401"),
    "separate admin credential enforced"
  );
  rec(
    j,
    "the rejected credential leaves revision 1 untouched",
    (await a.page.locator("#revision").textContent()) === "1",
    "no write occurred"
  );
  await shot(a.page, j, 1, "read-key-rejected");

  await tap(
    a.page,
    j,
    '[data-testid="test-invalid"]',
    "the reviewer submits a rollout whose weights total only 5000"
  );
  await waitForText(a.page, "#operation", "HTTP 400");
  rec(
    j,
    "the malformed ruleset is rejected",
    (await a.page.locator("#operation").textContent()).includes("HTTP 400"),
    "semantic ruleset validation failed"
  );
  rec(
    j,
    "the invalid snapshot never replaces revision 1",
    (await a.page.locator("#revision").textContent()) === "1",
    "last valid snapshot remains active"
  );
  await shot(a.page, j, 2, "invalid-ruleset-rejected");

  await tap(
    a.page,
    j,
    '[data-testid="test-concurrency"]',
    "the reviewer races two writers from the same revision"
  );
  await waitForText(a.page, "#operation", "200 + 409");
  await waitForText(a.page, "#revision", "2");
  rec(
    j,
    "exactly one concurrent writer succeeds and one conflicts",
    (await a.page.locator("#operation").textContent()).includes("200 + 409"),
    "optimistic concurrency enforced"
  );
  rec(
    j,
    "the race produces one monotonic revision instead of a lost update",
    (await a.page.locator("#revision").textContent()) === "2",
    "revision advanced exactly once"
  );
  rec(
    j,
    "the consumer remains usable after all rejected operations",
    await visible(a.page, '[data-testid="classic-checkout"]'),
    "valid off value still evaluates"
  );
  await shot(a.page, j, 3, "concurrency-conflict-contained");
  await closeSession(a, j);
});

// ── main: purge → run → report ──────────────────────────────────────────────
async function main() {
  // `PROOF_CHROME` points at a real Chrome binary when Playwright's own pinned
  // build isn't installable (its CDN currently answers 400 for every build).
  browser = await chromium.launch(
    process.env.PROOF_CHROME ? { executablePath: process.env.PROOF_CHROME } : {}
  );
  for (const name of ONLY || Object.keys(JOURNEYS)) {
    if (!JOURNEYS[name]) {
      console.log(`(skip) unknown journey ${name}`);
      continue;
    }
    console.log(`▶ ${name}`);
    try {
      await JOURNEYS[name]();
    } catch (e) {
      rec(name, "(exception)", false, String(e).slice(0, 200));
    } finally {
      const contexts = new Set(
        rp(name)
          .tracks.filter((track) => !track.video)
          .map((track) => track.ctx)
      );
      for (const ctx of contexts) await closeSession({ ctx }, name);
    }
  }
  await browser.close();

  if (BASELINE) {
    // Capture-only: shots-baseline/ is the deliverable, failures expected.
    console.log(
      `\n(baseline) captured against ${BASE} — rerun without --baseline to regenerate reports with before/after pairs`
    );
    process.exit(0);
  }
  if (REPLAY) {
    sweepVideos();
    // tracks hold live Playwright handles — serialise only what the report needs
    const journeys = Object.fromEntries(
      Object.entries(replays).map(([name, r]) => [
        name,
        {
          ...r,
          tracks: r.tracks.map(({ id, label, video, startedAt }) => ({
            id,
            label,
            video,
            startedAt
          }))
        }
      ])
    );
    fs.writeFileSync(
      path.join(FOLDER, "replay.json"),
      // overlay:true marks the video as CLEAN (cursor drawn by the player, not
      // baked in) so the player knows to draw one cursor, not double an old one.
      // pace travels with the pack so the player animates the cursor over the
      // same beats the run actually recorded, instead of guessing from gaps.
      JSON.stringify(
        { device: DEVICE, viewport: VIEWPORT, overlay: true, pace: PACE, journeys },
        null,
        1
      )
    );
  }
  const { pass, fail } = await writeReports({
    folder: FOLDER,
    base: BASE,
    title: "CoDuck Flags SDK — live rollout journeys",
    results,
    promises: PROMISES
  });
  console.log(`\n${pass} passed / ${fail} failed — REPORT.md + REPORT.html written`);
  process.exit(fail ? 1 : 0);
}
main();
