// Headful test of GPX/KML import: upload a real file through the file input
// and verify the trip is rebuilt from it and drawn as the imported path.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3150;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

// --- fixtures: a winding 300-point ride, plus a KML with waypoints ---
mkdirSync('/tmp/mm-fixtures', { recursive: true });

const pts = Array.from({ length: 300 }, (_, i) => {
  const t = i / 299;
  return [
    100.5018 + t * -1.5 + Math.sin(t * 22) * 0.06,
    13.7563 + t * 5.03 + Math.cos(t * 18) * 0.05,
  ];
});
const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><name>Bangkok to Chiang Mai Ride</name><trkseg>
${pts.map(([lng, lat], i) => `    <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><ele>${(10 + i * 0.9).toFixed(1)}</ele></trkpt>`).join('\n')}
  </trkseg></trk>
</gpx>`;
writeFileSync('/tmp/mm-fixtures/ride.gpx', GPX);

const KML_WPTS = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Louvre</name><Point><coordinates>2.3376,48.8606,0</coordinates></Point></Placemark>
  <Placemark><name>Eiffel Tower</name><Point><coordinates>2.2945,48.8584,0</coordinates></Point></Placemark>
  <Placemark><name>Notre Dame</name><Point><coordinates>2.3499,48.8530,0</coordinates></Point></Placemark>
</Document></kml>`;
writeFileSync('/tmp/mm-fixtures/paris.kml', KML_WPTS);

writeFileSync('/tmp/mm-fixtures/notes.txt', 'this is not a track file');

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

const routePoints = () =>
  page.evaluate(() => {
    const map = window.__map;
    const ids = Object.keys(map?.getStyle()?.sources ?? {});
    const id = ids.find((s) => s.startsWith('route-'));
    const src = id && map.getSource(id);
    const data = src?.serialize?.().data ?? src?._data;
    return data?.geometry?.coordinates?.length ?? -1;
  });

const stopCount = () => page.locator('[data-testid="stop-list"] li').count();

console.log('\n[import] GPX track');
await page.goto(`http://localhost:${PORT}/?style=minimal`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

await page.locator('[data-testid="track-file-input"]').setInputFiles('/tmp/mm-fixtures/ride.gpx');
await page.waitForTimeout(2500);

(await stopCount()) === 2 ? pass('GPX track collapses to start + finish stops') : fail('GPX track collapses to start + finish stops', await stopCount());

const mode = await page.locator('[data-testid="leg-0"]').getAttribute('data-mode');
mode === 'file' ? pass('imported leg uses track mode') : fail('imported leg uses track mode', mode);

const status = await page.locator('[data-testid="leg-0"]').getAttribute('data-status');
status === 'ok' ? pass('imported leg has geometry') : fail('imported leg has geometry', status);

// Seek to the end so the whole path is drawn.
await page.evaluate(() => {
  const r = [...document.querySelectorAll('input[type=range]')].pop();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(r, r.max);
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1500);
const n = await routePoints();
n > 2 && n !== 97
  ? pass(`drawn path is the imported track (${n} pts, simplified from 300, not the 97-pt arc)`)
  : fail('drawn path is the imported track', n);

await page.screenshot({ path: '/tmp/import-gpx.png' });

console.log('\n[import] KML waypoints');
await page.locator('[data-testid="track-file-input"]').setInputFiles('/tmp/mm-fixtures/paris.kml');
await page.waitForTimeout(2500);
(await stopCount()) === 3 ? pass('waypoint-only KML becomes 3 stops') : fail('waypoint-only KML becomes 3 stops', await stopCount());
const names = await page.locator('[data-testid="stop-list"] li').allInnerTexts();
names.join(' ').includes('Louvre') ? pass('waypoint names are kept') : fail('waypoint names are kept', names.join('|'));
const kmlMode = await page.locator('[data-testid="leg-0"]').getAttribute('data-mode');
kmlMode === 'air' ? pass('waypoint legs default to flight') : fail('waypoint legs default to flight', kmlMode);

console.log('\n[import] bad file');
await page.locator('[data-testid="track-file-input"]').setInputFiles('/tmp/mm-fixtures/notes.txt');
await page.waitForTimeout(1500);
const err = await page.locator('[data-testid="import-error"]').count();
err > 0 ? pass('non-track file shows an error') : fail('non-track file shows an error');
(await stopCount()) === 3 ? pass('failed import leaves the trip untouched') : fail('failed import leaves the trip untouched', await stopCount());

const playable = !(await page.getByRole('button', { name: /Play|Pause/ }).isDisabled());
playable ? pass('editor still usable after a bad import') : fail('editor still usable after a bad import');

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ GPX/KML import works' : '\n❌ Import has failures');
process.exit(ok ? 0 : 1);
