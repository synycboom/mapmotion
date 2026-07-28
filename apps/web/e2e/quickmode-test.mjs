// Headful end-to-end test of Quick mode: search a place, add it as a stop,
// reorder, switch format, verify the URL stays shareable, and export.
// Runs against the offline Minimal style so it needs no external network.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { rawStats } from './imgstats.mjs';

const PORT = 3130;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const app = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
const cleanup = () => { try { app.kill('SIGTERM'); } catch {} };
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await sleep(500);
}

const checks = {};
const fail = (k, detail) => { checks[k] = false; console.log(`  ✗ ${k}: ${detail ?? ''}`); };
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };

// ---- 1. API layer ----
console.log('\n[api] geocode');
const api = await (await fetch(`http://localhost:${PORT}/api/geocode?q=bangk`)).json();
api.results?.[0]?.name === 'Bangkok'
  ? pass('geocode returns Bangkok for "bangk"')
  : fail('geocode returns Bangkok for "bangk"', JSON.stringify(api).slice(0, 200));

const amb = await (await fetch(`http://localhost:${PORT}/api/geocode?q=paris`)).json();
amb.results?.[0]?.country === 'FR'
  ? pass('ambiguous "paris" ranks France first')
  : fail('ambiguous "paris" ranks France first', JSON.stringify(amb.results?.[0]));

const short = await (await fetch(`http://localhost:${PORT}/api/geocode?q=a`)).json();
short.results?.length === 0
  ? pass('sub-2-char query returns nothing')
  : fail('sub-2-char query returns nothing');

// ---- 2. UI ----
const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,950'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const mapErrors = [];
page.on('console', (m) => { if (m.text().includes('[mm-map-error]')) mapErrors.push(m.text()); });
page.on('pageerror', (e) => mapErrors.push(`pageerror: ${e.message}`));

console.log('\n[ui] quick mode');
await page.goto(`http://localhost:${PORT}/?style=minimal`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

const stopCount = async () => page.locator('[data-testid="stop-list"] li').count();
const initial = await stopCount();
initial === 3 ? pass('default trip has 3 stops') : fail('default trip has 3 stops', initial);

// Search + pick a result.
await page.locator('[data-testid="place-search"]').fill('reykjav');
await page.waitForSelector('[data-testid="place-results"] li', { timeout: 10_000 });
const firstResult = await page.locator('[data-testid="place-results"] li button').first().innerText();
firstResult.toLowerCase().includes('reykjav')
  ? pass('autocomplete finds Reykjavík (capital under pop threshold)')
  : fail('autocomplete finds Reykjavík', firstResult);

await page.locator('[data-testid="place-results"] li button').first().click();
await page.waitForTimeout(1200);
(await stopCount()) === initial + 1
  ? pass('picking a result appends a stop')
  : fail('picking a result appends a stop', await stopCount());

// Keyboard flow: type, ArrowDown, Enter.
await page.locator('[data-testid="place-search"]').fill('osaka');
await page.waitForSelector('[data-testid="place-results"] li', { timeout: 10_000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1000);
(await stopCount()) === initial + 2
  ? pass('keyboard Enter adds a stop')
  : fail('keyboard Enter adds a stop', await stopCount());

// Reorder.
const before = await page.locator('[data-testid="stop-list"] li').first().innerText();
await page.locator('[data-testid="stop-list"] li').nth(1).getByRole('button', { name: /Move .* up/ }).click();
await page.waitForTimeout(800);
const after = await page.locator('[data-testid="stop-list"] li').first().innerText();
before !== after ? pass('reordering changes stop order') : fail('reordering changes stop order', `${before} -> ${after}`);

// Remove.
const preRemove = await stopCount();
await page.locator('[data-testid="stop-list"] li').last().getByRole('button', { name: /Remove/ }).click();
await page.waitForTimeout(800);
(await stopCount()) === preRemove - 1 ? pass('removing a stop works') : fail('removing a stop works');

// URL state round-trip.
const url = page.url();
url.includes('s=') && url.includes('f=') ? pass('URL encodes state') : fail('URL encodes state', url);
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(3000);
const reloaded = await stopCount();
reloaded === preRemove - 1
  ? pass('reloading the URL restores the same stops')
  : fail('reloading the URL restores the same stops', `${reloaded} vs ${preRemove - 1}`);

// Vertical format resizes the canvas.
await page.getByRole('button', { name: '9:16' }).click();
await page.waitForTimeout(2500);
const canvas = await page.evaluate(() => {
  const c = document.querySelector('.maplibregl-canvas');
  return { w: c.width, h: c.height };
});
canvas.w === 720 && canvas.h === 1280
  ? pass('9:16 switches canvas to 720x1280')
  : fail('9:16 switches canvas to 720x1280', JSON.stringify(canvas));

await page.screenshot({ path: '/tmp/quickmode.png' });

// Back to 16:9.
await page.getByRole('button', { name: '16:9' }).click();
await page.waitForTimeout(2500);

// Speed control: raising it must shorten the animation. (Also keeps the
// export below the software-GL time budget in CI — a real GPU runs this
// ~25x faster.)
const durationOf = async () => {
  const t = await page.locator('text=/\\d+\\.\\ds \\/ \\d+\\.\\ds/').first().innerText();
  return Number(t.split('/')[1].trim().replace('s', ''));
};
const slowDur = await durationOf();
await page.locator('[data-testid="speed-slider"]').fill('2.5');
await page.waitForTimeout(2500);
const fastDur = await durationOf();
fastDur < slowDur * 0.6
  ? pass(`speed control shortens the trip (${slowDur}s -> ${fastDur}s)`)
  : fail('speed control shortens the trip', `${slowDur}s -> ${fastDur}s`);

console.log('\n[export] running…');
const href = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Export'),
  );
  if (!btn) return { error: 'no export button found' };
  if (btn.disabled) return { error: 'export button is disabled' };
  btn.click();
  let lastLabel = '';
  for (let i = 0; i < 420; i++) {
    const a = document.querySelector('a[download]');
    if (a) return { href: a.getAttribute('href') };
    const cur = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Export'),
    )?.textContent;
    if (cur) lastLabel = cur;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    error: 'timed out',
    lastLabel,
    pageError: document.body.innerText.slice(-500),
  };
}).then((r) => {
  if (r.error) console.log('  export diagnostics:', JSON.stringify(r, null, 2));
  return r.href ?? null;
});

if (href) {
  const b64 = await page.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  writeFileSync('/tmp/quickmode-export.webm', Buffer.from(b64, 'base64'));
  const stats = rawStats('/tmp/quickmode-export.webm', { frameSelect: 5 });
  console.log('  frame stats:', JSON.stringify(stats));
  stats.distinctColors > 20 && stats.stddev > 5
    ? pass('export of a user-built trip is non-blank')
    : fail('export of a user-built trip is non-blank', JSON.stringify(stats));
} else {
  fail('export of a user-built trip is non-blank', 'export never completed');
}

mapErrors.length === 0 ? pass('no map errors') : fail('no map errors', mapErrors.join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const allPass = Object.values(checks).every(Boolean);
const n = Object.keys(checks).length;
const p = Object.values(checks).filter(Boolean).length;
console.log(`${p}/${n} checks passed`);
console.log(allPass ? '\n✅ Quick mode works end to end' : '\n❌ Quick mode has failures');
process.exit(allPass ? 0 : 1);
