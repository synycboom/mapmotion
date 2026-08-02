// Headful test of templates and title cards.
//
// The key property for titles: the preview and the export must agree, because
// they share drawTitles(). So we assert the overlay canvas has pixels AND the
// exported video frame does, at the same moment in the timeline.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { click, exists, reveal } from './ui.mjs';
import { durationOf, rawStats } from './imgstats.mjs';

const PORT = 3160;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

const killTree = (child) => {
  // `npx next start` forks a `next-server` grandchild. Killing only the npx
  // wrapper leaves that grandchild alive holding the port — and because it
  // keeps serving from a `.next` directory a later build has since
  // overwritten, it answers the NEXT run with HTML pointing at chunk files
  // that no longer exist ("Loading chunk N failed"). Detaching puts it in its
  // own process group so the whole tree can be signalled at once.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
};

const app = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
const cleanup = () => { killTree(app); };
process.on('exit', cleanup);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await sleep(500);
}

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,950'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const stopCount = () => page.locator('[data-testid="stop-list"] li').count();
const seekTo = async (fraction) => {
  await page.evaluate((f) => {
    const r = [...document.querySelectorAll('input[type=range]')].pop();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(r, String(Number(r.max) * f));
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);
  await page.waitForTimeout(900);
};
/** Fraction of non-transparent pixels on the title overlay canvas. */
const overlayInk = () =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="title-overlay"]');
    if (!c) return -1;
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let on = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) on++;
    return on / (c.width * c.height);
  });

console.log('\n[templates]');
await page.goto(`http://localhost:${PORT}/?style=minimal`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

await click(page, 'template-road-trip');
await page.waitForTimeout(3000);
(await stopCount()) === 4 ? pass('road-trip template loads 4 stops') : fail('road-trip template loads 4 stops', await stopCount());
const names = (await page.locator('[data-testid="stop-list"] li').allInnerTexts()).join(' ');
names.includes('Monterey') ? pass('template stops are correct') : fail('template stops are correct', names.slice(0, 80));
const legMode = await (await reveal(page, 'leg-0')).getAttribute('data-mode');
legMode === 'car' ? pass('road-trip sets drive legs') : fail('road-trip sets drive legs', legMode);
const titleVal = await (await reveal(page, 'title-input')).inputValue();
titleVal === 'Road trip' ? pass('template fills the title card') : fail('template fills the title card', titleVal);

await click(page, 'template-vertical-shorts');
await page.waitForTimeout(3000);
const canvasSize = await page.evaluate(() => {
  const c = document.querySelector('.maplibregl-canvas');
  return { w: c.width, h: c.height };
});
canvasSize.w === 720 && canvasSize.h === 1280
  ? pass('vertical template switches to 9:16')
  : fail('vertical template switches to 9:16', JSON.stringify(canvasSize));

console.log('\n[titles]');
await click(page, 'template-world-tour');
await page.waitForTimeout(3000);
await (await reveal(page, 'title-input')).fill('Around the World');
await (await reveal(page, 'subtitle-input')).fill('2026');
await page.waitForTimeout(1500);

await seekTo(0.02);
const inkEarly = await overlayInk();
inkEarly > 0.001 ? pass(`intro title is drawn in the preview (${(inkEarly * 100).toFixed(1)}% ink)`) : fail('intro title is drawn in the preview', inkEarly);

await seekTo(0.6);
const inkMid = await overlayInk();
inkMid < 0.0005 ? pass('title is gone by mid-video') : fail('title is gone by mid-video', inkMid);

await seekTo(0.99);
const inkEndNoOutro = await overlayInk();
inkEndNoOutro < 0.0005 ? pass('no end card unless enabled') : fail('no end card unless enabled', inkEndNoOutro);

await (await reveal(page, 'outro-toggle')).check();
await page.waitForTimeout(1500);
await seekTo(0.985);
const inkEnd = await overlayInk();
inkEnd > 0.001 ? pass('end card appears when enabled') : fail('end card appears when enabled', inkEnd);

await page.screenshot({ path: '/tmp/titles.png' });

console.log('\n[export] titles must be burned into the video');
// Short + small so the software-GL render stays quick.
await page.goto(
  `http://localhost:${PORT}/?s=Bangkok,100.5018,13.7563~Tokyo,139.6917,35.6895&style=minimal&spd=2.5&res=0.4`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(3500);
await (await reveal(page, 'title-input')).fill('TITLE TEST');
await page.waitForTimeout(1500);

const href = await page.evaluate(async () => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.startsWith('Export'));
  if (!b || b.disabled) return null;
  b.click();
  for (let i = 0; i < 300; i++) {
    const a = document.querySelector('a[download]');
    if (a) return a.getAttribute('href');
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
});

if (href) {
  const b64 = await page.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  const out = '/tmp/titles-export.webm';
  writeFileSync(out, Buffer.from(b64, 'base64'));

  // Pick both sample points from the ACTUAL duration. Hard-coding a late
  // timestamp risks seeking past the end, where ffmpeg decodes nothing and
  // the comparison would pass for the wrong reason.
  const dur = durationOf(out);
  const early = rawStats(out, { frameSelect: 0.4 });
  const late = rawStats(out, { frameSelect: dur ? dur * 0.75 : 2 });
  console.log(`  duration ${dur?.toFixed(2)}s`);
  console.log(`  early frame (0.40s): ${early.distinctColors} colours, luma ${early.meanLuma}`);
  console.log(`  late frame  (${(dur * 0.75).toFixed(2)}s): ${late.distinctColors} colours, luma ${late.meanLuma}`);

  late.distinctColors > 20
    ? pass('late frame decoded (comparison is meaningful)')
    : fail('late frame decoded (comparison is meaningful)', late.distinctColors);
  // The title is bright white text on a dark scrim, so it both lifts the
  // distinct-colour count and darkens the mean luma versus a bare map frame.
  early.distinctColors > late.distinctColors
    ? pass(`exported intro frame carries the title (${early.distinctColors} vs ${late.distinctColors} colours)`)
    : fail('exported intro frame carries the title', `${early.distinctColors} vs ${late.distinctColors}`);
  early.distinctColors > 20
    ? pass('exported frames are not blank')
    : fail('exported frames are not blank', early.distinctColors);
} else {
  fail('exported intro frame carries the title', 'export did not complete');
  fail('exported frames are not blank', 'export did not complete');
}

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Templates and title cards work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
