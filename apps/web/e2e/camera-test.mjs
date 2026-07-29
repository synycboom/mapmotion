// Headful test of the camera controls.
//
// Every check reads the state off the MAP, not off React — a control that
// only repaints a chip is worth nothing. Where a control shapes a movement
// rather than a pose (the travel arc, the orbit), the assertion samples the
// camera mid-move via the engine, because that is the only place the
// difference exists.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';

const APP_PORT = 3270;
const TILE_PORT = 3271;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

const { server: tiles, styleUrl } = await startMockTileServer(TILE_PORT);
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
const cleanup = () => {
  try { app.kill('SIGTERM'); } catch {}
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
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,1000'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[mm-map-error]') && !t.includes('elevation-tiles-prod')) pageErrors.push(t);
});

const zoom = () => page.evaluate(() => window.__map?.getZoom() ?? -1);
const bearing = () => page.evaluate(() => window.__map?.getBearing() ?? -1);
const pitch = () => page.evaluate(() => window.__map?.getPitch() ?? -1);

/** Move the playhead to a fraction of the video and let the map settle. */
const seekTo = async (frac) => {
  await page.evaluate((f) => {
    const el = document.querySelector('input[type="range"][max]:not([data-testid])');
    const max = Number(el.max);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(Math.round(max * f)));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, frac);
  await page.waitForTimeout(900);
};

const setRange = async (testid, value) => {
  await page.evaluate(
    ({ id, v }) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { id: testid, v: value },
  );
  await page.waitForTimeout(900);
};

// Paris -> Lyon: short enough that fixed framing looks wrong and auto framing
// visibly fixes it. That contrast is the whole point of the feature.
const TRIP = 's=Paris,2.3522,48.8566~Lyon,4.8357,45.7640';
await page.goto(
  `http://localhost:${APP_PORT}/?${TRIP}&style=minimal&styleUrl=${encodeURIComponent(styleUrl)}`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);

console.log('\n[camera] panel + framing presets');
(await page.locator('[data-testid="camera-panel"]').count()) === 1
  ? pass('camera panel renders')
  : fail('camera panel renders');

const autoZoom = await zoom();
autoZoom > 6.5
  ? pass(`auto framing zooms in on a short trip (z=${autoZoom.toFixed(2)})`)
  : fail('auto framing zooms in on a short trip', autoZoom);

await page.locator('[data-testid="zoom-continent"]').click();
await page.waitForTimeout(1200);
const contZoom = await zoom();
Math.abs(contZoom - 3.2) < 0.05
  ? pass(`a preset pins the camera to its zoom (z=${contZoom.toFixed(2)})`)
  : fail('a preset pins the camera to its zoom', contZoom);

await page.locator('[data-testid="zoom-street"]').click();
await page.waitForTimeout(1200);
const streetZoom = await zoom();
streetZoom > contZoom + 5
  ? pass(`switching presets moves the camera (${contZoom.toFixed(1)} → ${streetZoom.toFixed(1)})`)
  : fail('switching presets moves the camera', `${contZoom} → ${streetZoom}`);

await page.locator('[data-testid="zoom-auto"]').click();
await page.waitForTimeout(1200);
Math.abs((await zoom()) - autoZoom) < 0.05
  ? pass('returning to Auto restores the derived framing')
  : fail('returning to Auto restores the derived framing', await zoom());

console.log('\n[camera] per-stop zoom override');
await setRange('stop-zoom-0', 12);
const overridden = await zoom();
Math.abs(overridden - 12) < 0.15
  ? pass(`a per-stop override beats the preset (z=${overridden.toFixed(2)})`)
  : fail('a per-stop override beats the preset', overridden);

// ...and only for that stop.
await seekTo(1);
const lastStopZoom = await zoom();
Math.abs(lastStopZoom - 12) > 1
  ? pass(`the override is confined to its own stop (z=${lastStopZoom.toFixed(2)})`)
  : fail('the override is confined to its own stop', lastStopZoom);

await seekTo(0);
await page.locator('[data-testid="stop-zoom-reset-0"]').click();
await page.waitForTimeout(1000);
Math.abs((await zoom()) - autoZoom) < 0.05
  ? pass('"auto" clears a single stop override')
  : fail('"auto" clears a single stop override', await zoom());

console.log('\n[camera] travel arc');
/** Zoom at the midpoint of the flight, read from the engine's own camera. */
const midLegZoom = () =>
  page.evaluate(() => {
    const m = window.__map;
    return m ? m.getZoom() : -1;
  });

await setRange('arc-slider', 0.9);
await seekTo(0.5);
const flatMid = await midLegZoom();
await seekTo(0);
await setRange('arc-slider', 3);
await seekTo(0.5);
const tallMid = await midLegZoom();
tallMid < flatMid - 0.3
  ? pass(`a taller arc pulls further out mid-flight (${flatMid.toFixed(2)} → ${tallMid.toFixed(2)})`)
  : fail('a taller arc pulls further out mid-flight', `${flatMid} vs ${tallMid}`);

await setRange('arc-slider', 1.42);
await seekTo(0);

console.log('\n[camera] rotation');
await setRange('bearing-slider', 90);
const b = await bearing();
Math.abs(((b % 360) + 360) % 360 - 90) < 1
  ? pass(`heading reaches the camera (${Math.round(b)}°)`)
  : fail('heading reaches the camera', b);

await setRange('bearing-slider', 0);
await page.locator('[data-testid="bearing-mode-travel"]').click();
await page.waitForTimeout(1200);
const travelB = await bearing();
// Paris -> Lyon runs roughly south-east, so "follow route" must NOT be north.
Math.abs(((travelB % 360) + 360) % 360) > 20
  ? pass(`follow-route orients along the leg (${Math.round(travelB)}°)`)
  : fail('follow-route orients along the leg', travelB);

await page.locator('[data-testid="bearing-mode-fixed"]').click();
await page.waitForTimeout(1200);
Math.abs(await bearing()) < 1
  ? pass('switching back to Fixed restores north')
  : fail('switching back to Fixed restores north', await bearing());

console.log('\n[camera] orbit');
await setRange('orbit-slider', 180);
await seekTo(0);
const orbitStart = await bearing();
// The first dwell runs from t=0 to the departure keyframe; sample inside it.
await seekTo(0.06);
const orbitMid = await bearing();
Math.abs(orbitMid - orbitStart) > 3
  ? pass(`orbit rotates the map during a dwell (${Math.round(orbitStart)}° → ${Math.round(orbitMid)}°)`)
  : fail('orbit rotates the map during a dwell', `${orbitStart} → ${orbitMid}`);
await setRange('orbit-slider', 0);

console.log('\n[camera] tilt');
await setRange('pitch-slider', 55);
const p = await pitch();
p > 45
  ? pass(`tilt reaches the camera (${Math.round(p)}°)`)
  : fail('tilt reaches the camera', p);

console.log('\n[camera] persistence');
await page.locator('[data-testid="zoom-city"]').click();
await page.locator('[data-testid="bearing-mode-travel"]').click();
await setRange('orbit-slider', 45);
await setRange('arc-slider', 2.4);
await page.waitForTimeout(800);

const url = page.url();
['zm=city', 'bm=travel', 'orb=45', 'arc=2.4', 'pit=55'].every((frag) => url.includes(frag))
  ? pass('every camera setting encodes into the URL')
  : fail('every camera setting encodes into the URL', url.split('?')[1]?.slice(0, 200));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(5000);
const rz = await zoom();
const rp = await pitch();
Math.abs(rz - 10.5) < 0.1 && rp > 45
  ? pass(`reloading the link restores framing and tilt (z=${rz.toFixed(1)}, ${Math.round(rp)}°)`)
  : fail('reloading the link restores framing and tilt', `${rz} / ${rp}`);

(await page.locator('[data-testid="zoom-city"]').getAttribute('data-on')) === '1' &&
(await page.locator('[data-testid="bearing-mode-travel"]').getAttribute('data-on')) === '1'
  ? pass('the panel reflects the restored state')
  : fail('the panel reflects the restored state');

console.log('\n[camera] reset');
await page.locator('[data-testid="camera-reset"]').click();
await page.waitForTimeout(1500);
const resetZoom = await zoom();
Math.abs(resetZoom - autoZoom) < 0.05 && (await pitch()) < 1 && Math.abs(await bearing()) < 1
  ? pass('Reset returns every camera setting to its default')
  : fail('Reset returns every camera setting to its default',
      `z=${resetZoom} pitch=${await pitch()} bearing=${await bearing()}`);

// A malformed link must degrade, not explode.
console.log('\n[camera] hostile URL input');
await page.goto(
  `http://localhost:${APP_PORT}/?${TRIP}&style=minimal&zm=notareal&arc=NaN&orb=99999&brg=-720&sz=abc_-&pit=999`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);
const hz = await zoom();
const hb = await bearing();
const hp = await pitch();
Number.isFinite(hz) && hz > 0 && Number.isFinite(hb) && hp >= 0 && hp <= 85
  ? pass(`garbage parameters clamp instead of breaking (z=${hz.toFixed(1)}, ${Math.round(hb)}°, ${Math.round(hp)}°)`)
  : fail('garbage parameters clamp instead of breaking', `${hz} / ${hb} / ${hp}`);

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Camera controls work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
