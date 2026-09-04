// /proof viewport sweep template — copy into <feature>-journeys/viewports.mjs.
// Four checks per size: the new surface is visible, fully inside the viewport,
// causes no horizontal scroll, and its primary control works when clicked.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || "5001";
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const FEATURE = '[data-testid="feature-slot"]';
const CONTROL = '[data-testid="rollout-100"]';

const SIZES = [
  ["320x568", 320, 568], // small phone
  ["390x844", 390, 844], // default phone
  ["430x932", 430, 932], // large phone
  ["768x1024", 768, 1024], // tablet
  ["1280x800", 1280, 800] // desktop
];

// `PROOF_CHROME` points at a real Chrome binary when Playwright's own pinned
// build isn't installable (its CDN currently answers 400 for every build).
const browser = await chromium.launch(
  process.env.PROOF_CHROME ? { executablePath: process.env.PROOF_CHROME } : {}
);
let fails = 0;
const results = [];
for (const [label, width, height] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const reset = await ctx.request.post(`${BASE}/api/reset`, { data: {} });
  if (!reset.ok()) throw new Error(`proof reset failed with HTTP ${reset.status()}`);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  const el = page.locator(FEATURE);
  const visible = await el.isVisible().catch(() => false);
  let inViewport = false;
  let horizScroll = true;
  if (visible) {
    const box = await el.boundingBox();
    inViewport = !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width;
    horizScroll = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1);
  }
  let controlOk = false;
  try {
    await page.locator(CONTROL).click({ timeout: 3000 });
    await page.locator('[data-testid="new-checkout"]').waitFor({ timeout: 3000 });
    controlOk = await page.locator('[data-testid="new-checkout"]').isVisible();
  } catch {
    /* recorded below */
  }

  await el.scrollIntoViewIfNeeded();
  const finalBox = await el.boundingBox();
  inViewport =
    !!finalBox &&
    finalBox.x >= 0 &&
    finalBox.y >= 0 &&
    finalBox.x + finalBox.width <= width &&
    finalBox.y + finalBox.height <= height;

  const ok = visible && inViewport && !horizScroll && controlOk;
  results.push({
    viewport: label,
    visible,
    inViewport,
    noHorizontalScroll: !horizScroll,
    controlWorks: controlOk,
    pass: ok
  });
  if (!ok) fails++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label} visible=${visible} inViewport=${inViewport} noHScroll=${!horizScroll} controlWorks=${controlOk}`
  );
  fs.mkdirSync(path.join(FOLDER, "shots/viewports"), { recursive: true });
  await page.screenshot({ path: path.join(FOLDER, `shots/viewports/${label}.png`) });
  await ctx.close();
}
await browser.close();
fs.writeFileSync(
  path.join(FOLDER, "viewports.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results, failed: fails }, null, 2) + "\n"
);
process.exit(fails ? 1 : 0);
