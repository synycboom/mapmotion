// Headful test of basemap appearance: label categories, projection, tilt,
// terrain. The point of each check is that the MAP actually changes — a
// toggle that only flips a chip is worthless.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';

const APP_PORT = 3240;
const TILE_PORT = 3241;
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
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,1000'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  // Elevation tiles come from S3, which this sandbox's proxy blocks. That's
  // environmental, not a product fault — the terrain assertions above still
  // verify the DEM is attached and detached correctly.
  if (t.includes('[mm-map-error]') && !t.includes('elevation-tiles-prod')) {
    pageErrors.push(t);
  }
});

/** Visibility of the mock style's place-label layer, read off the map. */
const labelVisibility = () =>
  page.evaluate(() => {
    const map = window.__map;
    const layer = map?.getStyle()?.layers?.find((l) => l.id === 'place-labels');
    if (!layer) return 'absent';
    return map.getLayoutProperty('place-labels', 'visibility') ?? 'visible';
  });

const cameraPitch = () => page.evaluate(() => window.__map?.getPitch() ?? -1);
const hasTerrain = () => page.evaluate(() => Boolean(window.__map?.getTerrain?.()));
const projectionName = () =>
  page.evaluate(() => {
    const p = window.__map?.getProjection?.();
    return typeof p === 'string' ? p : (p?.type ?? 'unknown');
  });

console.log('\n[appearance] label toggles');
await page.goto(
  `http://localhost:${APP_PORT}/?styleUrl=${encodeURIComponent(styleUrl)}`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);

(await page.locator('[data-testid="appearance-panel"]').count()) === 1
  ? pass('appearance panel renders')
  : fail('appearance panel renders');

(await labelVisibility()) === 'visible'
  ? pass('labels start visible')
  : fail('labels start visible', await labelVisibility());

await page.locator('[data-testid="label-places"]').click();
await page.waitForTimeout(1200);
(await labelVisibility()) === 'none'
  ? pass('hiding "cities & towns" hides the style layer')
  : fail('hiding "cities & towns" hides the style layer', await labelVisibility());
(await page.locator('[data-testid="label-places"]').getAttribute('data-on')) === '0'
  ? pass('chip reflects the off state')
  : fail('chip reflects the off state');

// Categories with no layers in this style must be disabled, not silently no-op.
(await page.locator('[data-testid="label-water"]').isDisabled())
  ? pass('categories absent from the basemap are disabled')
  : fail('categories absent from the basemap are disabled');

await page.locator('[data-testid="label-places"]').click();
await page.waitForTimeout(1000);
(await labelVisibility()) === 'visible'
  ? pass('re-enabling restores the layer')
  : fail('re-enabling restores the layer');

await page.locator('[data-testid="labels-toggle-all"]').click();
await page.waitForTimeout(1000);
(await labelVisibility()) === 'none'
  ? pass('"None" clears every category')
  : fail('"None" clears every category', await labelVisibility());

console.log('\n[appearance] tilt + terrain + projection');
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="pitch-slider"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, '55');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(2500);
const pitch = await cameraPitch();
pitch > 45
  ? pass(`tilt reaches the camera (${Math.round(pitch)}°)`)
  : fail('tilt reaches the camera', pitch);

await page.locator('[data-testid="terrain-toggle"]').check();
await page.waitForTimeout(2500);
(await hasTerrain())
  ? pass('terrain toggle attaches a DEM')
  : fail('terrain toggle attaches a DEM');
await page.locator('[data-testid="terrain-toggle"]').uncheck();
await page.waitForTimeout(1500);
!(await hasTerrain())
  ? pass('terrain can be turned back off')
  : fail('terrain can be turned back off');

await page.locator('[data-testid="projection-globe"]').click();
await page.waitForTimeout(2500);
const proj = await projectionName();
proj === 'globe'
  ? pass('globe projection applies')
  : fail('globe projection applies', proj);

await page.screenshot({ path: '/tmp/appearance.png' });

console.log('\n[appearance] persistence');
const url = page.url();
url.includes('lb=') && url.includes('pit=') && url.includes('prj=globe')
  ? pass('appearance encodes into the URL')
  : fail('appearance encodes into the URL', url.split('?')[1]?.slice(0, 120));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(5000);
(await labelVisibility()) === 'none' && (await cameraPitch()) > 45
  ? pass('reloading the link restores labels and tilt')
  : fail('reloading the link restores labels and tilt', `${await labelVisibility()} / ${await cameraPitch()}`);

// A style switch must not silently reset appearance.
console.log('\n[appearance] survives a style switch');
await page.selectOption('select', 'minimal');
await page.waitForTimeout(4000);
(await cameraPitch()) > 45
  ? pass('tilt survives a style switch')
  : fail('tilt survives a style switch', await cameraPitch());

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Map appearance controls work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
