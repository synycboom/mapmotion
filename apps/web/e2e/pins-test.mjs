// Headful test of marker styles. Each check asserts the MAP changed — that
// the right layer is carrying the features and the sprite exists — not just
// that a chip lit up.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3220;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

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

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,1000'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.text().includes('[mm-map-error]')) pageErrors.push(m.text()); });

/** What the markers source says each feature's style is. */
const markerStyles = () =>
  page.evaluate(() => {
    const src = window.__map?.getSource('markers');
    const data = src?.serialize?.().data ?? src?._data;
    return (data?.features ?? []).map((f) => f.properties?.style);
  });

const layerExists = (id) => page.evaluate((i) => Boolean(window.__map?.getLayer(i)), id);
const spriteIds = () =>
  page.evaluate(() => (window.__map?.listImages?.() ?? []).filter((i) => i.startsWith('mm-veh-')));

console.log('\n[pins] default');
await page.goto(`http://localhost:${PORT}/?style=minimal`, { waitUntil: 'load' });
await page.waitForTimeout(4000);

(await markerStyles()).every((s) => s === 'dot')
  ? pass('markers default to dot')
  : fail('markers default to dot', JSON.stringify(await markerStyles()));

for (const layer of ['marker-dots', 'marker-sprites', 'marker-emoji', 'marker-bubbles', 'marker-labels']) {
  if (!(await layerExists(layer))) fail(`layer ${layer} installed`, 'missing');
}
if (Object.keys(checks).length === 1) pass('all marker layers installed');

console.log('\n[pins] switching styles');
await page.locator('[data-testid="pin-pin"]').click();
await page.waitForTimeout(2500);
(await markerStyles()).every((s) => s === 'pin')
  ? pass('choosing "Pin" restyles every marker')
  : fail('choosing "Pin" restyles every marker', JSON.stringify(await markerStyles()));
(await spriteIds()).some((i) => i.includes('pinshape'))
  ? pass('pin sprite is rasterised and registered')
  : fail('pin sprite is rasterised and registered', JSON.stringify(await spriteIds()));

await page.locator('[data-testid="pin-marker"]').click();
await page.waitForTimeout(2500);
(await spriteIds()).some((i) => i.includes('markershape'))
  ? pass('marker sprite registered')
  : fail('marker sprite registered');

await page.locator('[data-testid="pin-emoji"]').click();
await page.waitForTimeout(1200);
// Emoji with no character set must fall back rather than render nothing.
(await markerStyles()).every((s) => s === 'dot')
  ? pass('emoji with no character falls back to dot')
  : fail('emoji with no character falls back to dot', JSON.stringify(await markerStyles()));

// The emoji field only renders while the emoji style is selected.
const hasField = (await page.locator('[data-testid="pin-emoji-input"]').count()) > 0;
if (hasField) {
  await page.locator('[data-testid="pin-emoji-input"]').fill('⛰');
  await page.waitForTimeout(2000);
  (await markerStyles()).every((s) => s === 'emoji')
    ? pass('setting an emoji activates the emoji style')
    : fail('setting an emoji activates the emoji style', JSON.stringify(await markerStyles()));
} else {
  fail('setting an emoji activates the emoji style', 'emoji field not rendered');
}

await page.locator('[data-testid="pin-bubble"]').click();
await page.waitForTimeout(2000);
const bubbleFeatures = await page.evaluate(() => {
  const src = window.__map?.getSource('markers');
  const data = src?.serialize?.().data ?? src?._data;
  return (data?.features ?? []).map((f) => ({
    style: f.properties?.style,
    showLabel: f.properties?.showLabel,
    bubble: f.properties?.bubble,
  }));
});
bubbleFeatures.every((f) => f.style === 'bubble' && f.showLabel === 0 && f.bubble)
  ? pass('bubble carries the name and suppresses the duplicate label')
  : fail('bubble carries the name and suppresses the duplicate label', JSON.stringify(bubbleFeatures[0]));

await page.locator('[data-testid="pin-none"]').click();
await page.waitForTimeout(1500);
(await markerStyles()).every((s) => s === 'none')
  ? pass('"Hidden" removes markers from every layer')
  : fail('"Hidden" removes markers from every layer');

console.log('\n[pins] colour and size');
await page.locator('[data-testid="pin-dot"]').click();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="pin-size"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, '2.5');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1500);
const sizes = await page.evaluate(() => {
  const src = window.__map?.getSource('markers');
  const data = src?.serialize?.().data ?? src?._data;
  return (data?.features ?? []).map((f) => f.properties?.size);
});
sizes.every((s) => s > 2)
  ? pass(`size slider reaches the features (${sizes[0]}×)`)
  : fail('size slider reaches the features', JSON.stringify(sizes));

await page.screenshot({ path: '/tmp/pins.png' });

console.log('\n[pins] persistence');
await page.locator('[data-testid="pin-pin"]').click();
await page.waitForTimeout(1200);
await page.locator('[data-testid="save-project"]').click();
await page.waitForTimeout(800);
await page.locator('[data-testid="pin-dot"]').click();
await page.waitForTimeout(1200);
await page.locator('[data-testid="toggle-library"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="project-item"] button').first().click();
await page.waitForTimeout(2500);
(await markerStyles()).every((s) => s === 'pin')
  ? pass('marker style survives save/load')
  : fail('marker style survives save/load', JSON.stringify(await markerStyles()));

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Marker styles work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
