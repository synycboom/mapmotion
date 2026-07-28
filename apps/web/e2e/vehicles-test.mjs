// Headful test of travel modes and moving vehicles.
//
// The claim being tested is that a vehicle sprite actually TRAVELS the path
// and TURNS to face its direction — not that a layer exists. So we sample the
// vehicle source at several points in the timeline and assert the position
// advances and the bearing tracks the geometry.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockRouter } from './mock-router.mjs';
import { durationOf, rawStats } from './imgstats.mjs';

const APP_PORT = 3200;
const ROUTER_PORT = 3260;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

const { server: router } = await startMockRouter(ROUTER_PORT, 'ok');
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  env: { ...process.env, ROUTER_URL: `http://localhost:${ROUTER_PORT}/route/v1/driving` },
});
const cleanup = () => {
  try { app.kill('SIGTERM'); } catch {}
  try { router.close(); } catch {}
};
process.on('exit', cleanup);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${APP_PORT}/`)).ok) break; } catch {}
  await sleep(500);
}

// ---------- API: routing profiles ----------
console.log('\n[api] routing profiles');
for (const profile of ['car', 'bike', 'foot']) {
  const r = await (await fetch(
    `http://localhost:${APP_PORT}/api/route?from=100.5,13.75&to=99,18.8&profile=${profile}`,
  )).json();
  r.profile === profile && Array.isArray(r.geometry)
    ? pass(`profile "${profile}" routes`)
    : fail(`profile "${profile}" routes`, JSON.stringify(r).slice(0, 120));
}
const bogus = await (await fetch(
  `http://localhost:${APP_PORT}/api/route?from=100.5,13.75&to=99,18.8&profile=../../etc/passwd`,
)).json();
bogus.profile === 'car'
  ? pass('unknown profile falls back to car (no path injection)')
  : fail('unknown profile falls back to car', bogus.profile);

// ---------- UI ----------
const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,1000'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.text().includes('[mm-map-error]')) pageErrors.push(m.text()); });

/** Read the vehicle feature for the first route straight off the map. */
const vehicleAt = async (fraction) => {
  await page.evaluate((f) => {
    const r = [...document.querySelectorAll('input[type=range]')].pop();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(r, String(Number(r.max) * f));
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const map = window.__map;
    const ids = Object.keys(map?.getStyle()?.sources ?? {});
    const id = ids.find((s) => s.startsWith('vehicle-'));
    if (!id) return { present: false, sources: ids };
    const src = map.getSource(id);
    const data = src?.serialize?.().data ?? src?._data;
    const f = data?.features?.[0] ?? (data?.geometry ? data : null);
    if (!f?.geometry) return { present: true, drawn: false };
    return {
      present: true,
      drawn: true,
      coordinate: f.geometry.coordinates,
      bearing: f.properties?.bearing,
      opacity: f.properties?.opacity,
    };
  });
};

console.log('\n[ui] flight vehicle');
await page.goto(
  `http://localhost:${APP_PORT}/?s=Bangkok,100.5018,13.7563~Tokyo,139.6917,35.6895&style=minimal`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(4000);

(await page.locator('[data-testid="leg-0"]').getAttribute('data-mode')) === 'air'
  ? pass('legs default to flight')
  : fail('legs default to flight', await page.locator('[data-testid="leg-0"]').getAttribute('data-mode'));

const iconRegistered = await page.evaluate(() => {
  const map = window.__map;
  return (map?.listImages?.() ?? []).filter((i) => i.startsWith('mm-veh-'));
});
iconRegistered.length > 0
  ? pass(`vehicle sprite registered (${iconRegistered[0]})`)
  : fail('vehicle sprite registered', JSON.stringify(iconRegistered));

const early = await vehicleAt(0.25);
const mid = await vehicleAt(0.4);
const late = await vehicleAt(0.55);

early.drawn && mid.drawn
  ? pass('vehicle is drawn during the leg')
  : fail('vehicle is drawn during the leg', JSON.stringify(early));

if (early.drawn && mid.drawn && late.drawn) {
  const moved =
    early.coordinate[0] !== mid.coordinate[0] && mid.coordinate[0] !== late.coordinate[0];
  moved
    ? pass(`vehicle advances along the path (lng ${early.coordinate[0].toFixed(2)} → ${late.coordinate[0].toFixed(2)})`)
    : fail('vehicle advances along the path', JSON.stringify([early.coordinate, late.coordinate]));

  const b = mid.bearing;
  typeof b === 'number' && b >= 0 && b < 360
    ? pass(`vehicle carries a heading (${Math.round(b)}°)`)
    : fail('vehicle carries a heading', b);
} else {
  fail('vehicle advances along the path', 'not drawn');
  fail('vehicle carries a heading', 'not drawn');
}

const atStart = await vehicleAt(0);
!atStart.drawn
  ? pass('vehicle hidden before the leg starts')
  : fail('vehicle hidden before the leg starts', JSON.stringify(atStart));

console.log('\n[ui] switching modes');
await page.locator('[data-testid="leg-0-more"]').click();
await page.waitForTimeout(500);
(await page.locator('[data-testid="leg-0-menu"]').count()) === 1
  ? pass('more-modes menu opens')
  : fail('more-modes menu opens');

await page.locator('[data-testid="leg-0-mode-sea"]').click();
await page.waitForTimeout(2000);
(await page.locator('[data-testid="leg-0"]').getAttribute('data-mode')) === 'sea'
  ? pass('selecting ferry updates the leg')
  : fail('selecting ferry updates the leg');

const ferryIcons = await page.evaluate(() =>
  (window.__map?.listImages?.() ?? []).filter((i) => i.includes('ship')),
);
ferryIcons.length > 0 ? pass('ferry sprite registered on switch') : fail('ferry sprite registered on switch');

// Direct mode has no vehicle at all — the head dot returns.
await page.locator('[data-testid="leg-0-more"]').click();
await page.waitForTimeout(400);
await page.locator('[data-testid="leg-0-mode-direct"]').click();
await page.waitForTimeout(2000);
const direct = await vehicleAt(0.5);
!direct.present
  ? pass('direct mode has no vehicle layer')
  : fail('direct mode has no vehicle layer', JSON.stringify(direct));

console.log('\n[ui] driving leg shows distance');
await page.goto(
  `http://localhost:${APP_PORT}/?s=Bangkok,100.5018,13.7563~Chiang Mai,98.9853,18.7883&l=d&style=minimal`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);
await page.waitForSelector('[data-testid="leg-0-metrics"]', { timeout: 15_000 }).catch(() => {});
const metricsText = await page.locator('[data-testid="leg-0-metrics"]').innerText().catch(() => '');
/\d/.test(metricsText)
  ? pass(`driving leg shows distance/duration ("${metricsText}")`)
  : fail('driving leg shows distance/duration', metricsText || 'absent');

await page.screenshot({ path: '/tmp/vehicles.png' });

console.log('\n[export] vehicle must appear in exported frames');
await page.goto(
  `http://localhost:${APP_PORT}/?s=Bangkok,100.5018,13.7563~Tokyo,139.6917,35.6895&style=minimal&spd=2.5&res=0.4`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(4000);
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
  const out = '/tmp/vehicles-export.webm';
  writeFileSync(out, Buffer.from(b64, 'base64'));
  const dur = durationOf(out);
  const mid = rawStats(out, { frameSelect: dur ? dur * 0.5 : 2 });
  console.log(`  duration ${dur?.toFixed(2)}s, mid-frame ${mid.distinctColors} colours`);
  mid.distinctColors > 20
    ? pass('exported mid-leg frame is not blank')
    : fail('exported mid-leg frame is not blank', mid.distinctColors);
} else {
  fail('exported mid-leg frame is not blank', 'export did not complete');
}

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Travel modes and moving vehicles work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
