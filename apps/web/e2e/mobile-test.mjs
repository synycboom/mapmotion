// Regression test for the bug where the editor rendered a blank preview on
// phone-width viewports.
//
// The old code computed the preview scale as
//   (window.innerWidth - 400) / outputWidth
// which is NEGATIVE on any viewport narrower than 400px plus the output
// width's share. `transform: scale(-0.008)` mirrors the map down to nothing,
// so the map was invisible on screen while its WebGL canvas kept rendering
// perfectly — which is exactly why exports still looked right.
//
// The assertions here are therefore about what is ON SCREEN, measured from
// the page screenshot, not about whether the canvas exists.
import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';
import { pngStats } from './imgstats.mjs';

const APP_PORT = 3250;
const TILE_PORT = 3251;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

const { server: tiles, styleUrl } = await startMockTileServer(TILE_PORT);
const killTree = (child) => {
  // `npx next start` forks a `next-server` grandchild. Killing only the npx
  // wrapper leaves that grandchild alive holding the port — and because it
  // keeps serving from a `.next` directory a later build has since
  // overwritten, it answers the NEXT run with HTML pointing at chunk files
  // that no longer exist ("Loading chunk N failed"). Detaching puts it in its
  // own process group so the whole tree can be signalled at once.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
};

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
const cleanup = () => {
  killTree(app);
  try { tiles.close(); } catch {}
};
process.on('exit', cleanup);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${APP_PORT}/`)).ok) break; } catch {}
  await sleep(500);
}

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1200,900'],
});

const URL_ = `http://localhost:${APP_PORT}/?s=Bangkok,100.5018,13.7563~Tokyo,139.6917,35.6895&styleUrl=${encodeURIComponent(styleUrl)}`;

/**
 * Everything we need to judge "is the map actually visible", read from the
 * live layout rather than from React state.
 */
const previewGeometry = (page) =>
  page.evaluate(() => {
    const frame = document.querySelector('[data-testid="preview-frame"]');
    const canvas = document.querySelector('canvas.maplibregl-canvas');
    const r = frame?.getBoundingClientRect();
    const c = canvas?.getBoundingClientRect();
    // MapLibre puts `.maplibregl-map` on the container div we hand it — which
    // is the element carrying the preview's scale transform. Reading the
    // PARENT here would silently return `none` and make the check vacuous.
    const holder = canvas?.closest('.maplibregl-map');
    const tf = holder ? getComputedStyle(holder).transform : 'none';
    // matrix(a, b, c, d, e, f) — `a` is the horizontal scale factor.
    const a = tf && tf !== 'none' ? Number(tf.slice(7).split(',')[0]) : 1;
    return {
      frame: r ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } : null,
      canvasOnScreen: c ? { w: Math.round(c.width), h: Math.round(c.height) } : null,
      scaleX: a,
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
    };
  });

/**
 * Run the visibility assertions for one device profile. `label` prefixes the
 * check names so a failure says which viewport broke.
 */
async function checkViewport(label, contextOpts, expect) {
  console.log(`\n[mobile] ${label}`);
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(5000);

  const g = await previewGeometry(page);

  // The actual bug: a negative or zero scale factor.
  g.scaleX > 0
    ? pass(`${label}: preview scale is positive (${g.scaleX.toFixed(3)})`)
    : fail(`${label}: preview scale is positive`, g.scaleX);

  // And the consequence: a frame with real on-screen area.
  g.frame && g.frame.w > 80 && g.frame.h > 45
    ? pass(`${label}: preview has real on-screen size (${g.frame.w}×${g.frame.h})`)
    : fail(`${label}: preview has real on-screen size`, JSON.stringify(g.frame));

  // It must also be inside the viewport, not scrolled off to one side.
  g.frame && g.frame.x >= -1 && g.frame.x + g.frame.w <= g.innerW + 2
    ? pass(`${label}: preview sits inside the viewport`)
    : fail(`${label}: preview sits inside the viewport`, `x=${g.frame?.x} w=${g.frame?.w} vw=${g.innerW}`);

  // No sideways rubber-banding from the full-size map div.
  g.docScrollW <= g.innerW + 2
    ? pass(`${label}: no horizontal overflow`)
    : fail(`${label}: no horizontal overflow`, `${g.docScrollW} > ${g.innerW}`);

  // Stacking order: on a phone the map must come before the controls.
  const order = await page.evaluate(() => {
    const pre = document.querySelector('[data-testid="preview-pane"]');
    const ctl = document.querySelector('[data-testid="controls"]');
    if (!pre || !ctl) return null;
    return { pre: pre.getBoundingClientRect().y, ctl: ctl.getBoundingClientRect().y };
  });
  if (expect.stacked) {
    order && order.pre < order.ctl
      ? pass(`${label}: map is stacked above the controls`)
      : fail(`${label}: map is stacked above the controls`, JSON.stringify(order));
  } else {
    order && Math.abs(order.pre - order.ctl) < 60
      ? pass(`${label}: side-by-side layout retained`)
      : fail(`${label}: side-by-side layout retained`, JSON.stringify(order));
  }

  // The decisive one: real pixels. A WebGL canvas read back outside a paint
  // frame comes back black, so screenshot the page and measure that instead.
  const shot = `/tmp/mobile-${label.replace(/\W+/g, '-')}.png`;
  await page.screenshot({ path: shot });
  if (!g.frame || g.frame.w < 2 || g.frame.h < 2) {
    // Without a rect, pngStats would sample the WHOLE page and pass on the
    // sidebar's colours — the check has to fail loudly instead.
    fail(`${label}: map area is painted`, 'no measurable preview frame');
  } else {
    const stats = pngStats(shot, g.frame, g.dpr);
    stats.distinctColors > 12
      ? pass(`${label}: map area is painted (${stats.distinctColors} colours)`)
      : fail(`${label}: map area is painted`, `${stats.distinctColors} colours — blank`);
  }

  pageErrors.length === 0
    ? pass(`${label}: no page errors`)
    : fail(`${label}: no page errors`, pageErrors.slice(0, 2).join('; '));

  await ctx.close();
}

await checkViewport('iphone', { ...devices['iPhone 13'] }, { stacked: true });
await checkViewport('iphone-landscape', { ...devices['iPhone 13 landscape'] }, { stacked: true });
await checkViewport('ipad', { ...devices['iPad Mini'] }, { stacked: true });
await checkViewport('desktop', { viewport: { width: 1440, height: 900 } }, { stacked: false });

// Reflow: rotating a phone must re-fit rather than keep a stale scale.
console.log('\n[mobile] reflow on rotation');
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(4500);
const before = (await previewGeometry(page)).frame;
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(2000);
const after = (await previewGeometry(page)).frame;
after && after.w !== before.w && after.w > 80
  ? pass(`re-fits on rotation (${before.w}×${before.h} → ${after.w}×${after.h})`)
  : fail('re-fits on rotation', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
await ctx.close();

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ The editor renders on phone and tablet viewports' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
