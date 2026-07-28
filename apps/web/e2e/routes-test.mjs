// Headful test of driving routes.
//
// The important property here isn't just "drive mode works" — it's that the
// editor degrades gracefully when routing fails. A router outage must change
// how a video looks, never break it. So the suite runs three servers: a
// healthy one, a 503 one, and one that answers "no route exists".
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockRouter } from './mock-router.mjs';

const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

// Bangkok -> Chiang Mai: genuinely road-connected, so 'drive' is meaningful.
const TRIP = 's=Bangkok,100.5018,13.7563~Chiang Mai,98.9853,18.7883';

async function withRouter(mode, port, appPort, fn) {
  const { server } = await startMockRouter(port, mode);
  const app = spawn('npx', ['next', 'start', '-p', String(appPort)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
    env: {
      ...process.env,
      ROUTER_URL: `http://localhost:${port}/route/v1/driving`,
    },
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://localhost:${appPort}/`)).ok) break; } catch {}
      await sleep(500);
    }
    await fn(appPort);
  } finally {
    try { app.kill('SIGTERM'); } catch {}
    try { server.close(); } catch {}
    await sleep(1200);
  }
}

// ---------- 1. API contract ----------
console.log('\n[api] routing endpoint');
await withRouter('ok', 3221, 3140, async (port) => {
  const r = await (await fetch(
    `http://localhost:${port}/api/route?from=100.5018,13.7563&to=98.9853,18.7883`,
  )).json();
  Array.isArray(r.geometry) && r.geometry.length > 2
    ? pass(`healthy router returns geometry (${r.points} pts, simplified from ${r.rawPoints})`)
    : fail('healthy router returns geometry', JSON.stringify(r).slice(0, 200));
  r.rawPoints > r.points
    ? pass('geometry is simplified server-side')
    : fail('geometry is simplified server-side', `${r.rawPoints} -> ${r.points}`);

  const bad = await fetch(`http://localhost:${port}/api/route?from=abc&to=1,2`);
  bad.status === 400 ? pass('bad coordinates rejected') : fail('bad coordinates rejected', bad.status);
});

await withRouter('fail', 3222, 3141, async (port) => {
  const res = await fetch(
    `http://localhost:${port}/api/route?from=100.5018,13.7563&to=98.9853,18.7883`,
  );
  const r = await res.json();
  res.status === 200 && r.geometry === null
    ? pass(`router 503 -> 200 with null geometry (reason: ${r.reason})`)
    : fail('router 503 -> 200 with null geometry', `${res.status} ${JSON.stringify(r)}`);
});

await withRouter('noroute', 3223, 3142, async (port) => {
  const r = await (await fetch(
    `http://localhost:${port}/api/route?from=100.5018,13.7563&to=98.9853,18.7883`,
  )).json();
  r.geometry === null && r.reason?.includes('NoRoute')
    ? pass('no-route answer surfaces as null geometry')
    : fail('no-route answer surfaces as null geometry', JSON.stringify(r));
});

// ---------- 2. UI: drive mode changes the drawn route ----------
console.log('\n[ui] drive mode');
const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,950'],
});

// Read the drawn route geometry back off the map. MapLibre doesn't expose a
// public getter for a GeoJSON source's current data, so try the documented
// serialize() first and fall back to internals across versions.
const routePointCount = (page) =>
  page.evaluate(() => {
    const map = window.__map;
    if (!map) return { n: -1, why: 'no map' };
    const ids = Object.keys(map.getStyle()?.sources ?? {});
    const id = ids.find((s) => s.startsWith('route-')) ?? 'route-route-1';
    const src = map.getSource(id);
    if (!src) return { n: -1, why: `no source; have: ${ids.join(',')}` };
    const data =
      src.serialize?.().data ?? src._data ?? src._options?.data ?? null;
    if (!data) return { n: -1, why: `no data on ${id}` };
    const coords =
      data.geometry?.coordinates ??
      data.features?.[0]?.geometry?.coordinates ??
      null;
    return { n: coords?.length ?? -1, why: coords ? '' : `shape: ${JSON.stringify(data).slice(0, 120)}` };
  });

await withRouter('ok', 3224, 3143, async (port) => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const mapErrors = [];
  page.on('pageerror', (e) => mapErrors.push(e.message));
  page.on('console', (m) => { if (m.text().includes('[mm-map-error]')) mapErrors.push(m.text()); });

  await page.goto(`http://localhost:${port}/?${TRIP}&style=minimal`, { waitUntil: 'load' });
  await page.waitForTimeout(3500);

  // Seek to the end so the full route geometry is drawn.
  const seekEnd = async () => {
    await page.evaluate(() => {
      const r = [...document.querySelectorAll('input[type=range]')].pop();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(r, r.max);
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(1200);
  };

  await page.locator('[data-testid="leg-0"]').waitFor({ timeout: 10_000 });
  (await page.locator('[data-testid="leg-0"]').getAttribute('data-mode')) === 'flight'
    ? pass('legs default to flight')
    : fail('legs default to flight');

  await seekEnd();
  const arc = await routePointCount(page);
  arc.n === 97 ? pass('flight leg draws a 97-point arc') : fail('flight leg draws a 97-point arc', `${arc.n} ${arc.why}`);

  // Switch to drive.
  await page.getByRole('button', { name: 'Leg 1 as drive' }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="leg-0"]')?.getAttribute('data-status') === 'ok',
    null,
    { timeout: 20_000 },
  ).catch(() => {});
  const status = await page.locator('[data-testid="leg-0"]').getAttribute('data-status');
  status === 'ok' ? pass('drive leg resolves road geometry') : fail('drive leg resolves road geometry', status);

  await seekEnd();
  const drive = await routePointCount(page);
  drive.n > 2 && drive.n !== 97
    ? pass(`drive leg draws road geometry (${drive.n} pts, not the arc)`)
    : fail('drive leg draws road geometry', `${drive.n} ${drive.why}`);

  // URL carries the leg mode, and a reload restores it.
  page.url().includes('l=d') ? pass('URL encodes leg mode') : fail('URL encodes leg mode', page.url());
  await page.goto(page.url(), { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  (await page.locator('[data-testid="leg-0"]').getAttribute('data-mode')) === 'drive'
    ? pass('reload restores drive mode')
    : fail('reload restores drive mode');

  await page.screenshot({ path: '/tmp/routes-drive.png' });
  mapErrors.length === 0 ? pass('no map errors (healthy router)') : fail('no map errors (healthy router)', mapErrors.join('; '));
  await page.close();
});

// ---------- 3. UI: routing failure degrades to an arc ----------
console.log('\n[ui] graceful degradation');
await withRouter('fail', 3225, 3144, async (port) => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const mapErrors = [];
  page.on('pageerror', (e) => mapErrors.push(e.message));

  await page.goto(`http://localhost:${port}/?${TRIP}&l=d&style=minimal`, { waitUntil: 'load' });
  await page.waitForTimeout(5000);

  const status = await page.locator('[data-testid="leg-0"]').getAttribute('data-status');
  status === 'fallback'
    ? pass('failed routing marks the leg as fallback')
    : fail('failed routing marks the leg as fallback', status);

  const warned = await page.locator('text=no road route').count();
  warned > 0 ? pass('user is told there is no road route') : fail('user is told there is no road route');

  await page.evaluate(() => {
    const r = [...document.querySelectorAll('input[type=range]')].pop();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(r, r.max);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  const pts = await routePointCount(page);
  pts.n === 97 ? pass('falls back to the great-circle arc') : fail('falls back to the great-circle arc', `${pts.n} ${pts.why}`);

  const playDisabled = await page.getByRole('button', { name: /Play|Pause/ }).isDisabled();
  !playDisabled ? pass('editor stays usable after routing failure') : fail('editor stays usable after routing failure');

  mapErrors.length === 0 ? pass('no page errors during failure') : fail('no page errors during failure', mapErrors.join('; '));
  await page.close();
});

await browser.close();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Driving routes work, and routing failures degrade cleanly' : '\n❌ Route handling has failures');
process.exit(ok ? 0 : 1);
