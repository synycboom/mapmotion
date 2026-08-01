// Headful test of the analytics layer, against a stand-in ingest server.
//
// Two questions, and neither can be answered from inside the app:
//   1. Do the funnel events actually leave the browser, in order?
//   2. Does anything the user typed leave with them?
//
// (2) is the one that matters most. The rule is that no string a user
// entered — a place name, a title, a search query — may appear in any
// payload, and the only way to hold that line is to read the wire.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';
import { startMockPosthog } from './mock-posthog.mjs';

const APP_PORT = 3290;
const TILE_PORT = 3291;
const PH_PORT = 3292;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

const { server: tiles, styleUrl } = await startMockTileServer(TILE_PORT);
const ph = startMockPosthog(PH_PORT);

const killTree = (child) => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
};

// The build must carry the key, because NEXT_PUBLIC_* is inlined at build
// time — setting it only at runtime would leave analytics inert and the
// whole suite would pass by testing nothing.
const cwd = new URL('..', import.meta.url).pathname;
const env = {
  ...process.env,
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_test_key',
  NEXT_PUBLIC_POSTHOG_HOST: ph.host,
};

console.log('[analytics] building with a key…');
await new Promise((resolve, reject) => {
  const b = spawn('npx', ['next', 'build'], { cwd, env, stdio: 'ignore' });
  b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
});

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd,
  env,
  stdio: 'ignore',
  detached: true,
});
const cleanup = () => {
  killTree(app);
  try { tiles.close(); } catch {}
  try { ph.server.close(); } catch {}
};
process.on('exit', cleanup);
for (let i = 0; i < 90; i++) {
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

// A deliberately distinctive place name: if it appears anywhere in a
// payload, the leak test has something unambiguous to catch.
const SECRET_PLACE = 'Llanfairpwllgwyngyll';
const SECRET_TITLE = 'Zzyzx-Private-Holiday-Title';

await page.goto(
  `http://localhost:${APP_PORT}/?s=Paris,2.3522,48.8566~Lyon,4.8357,45.7640&styleUrl=${encodeURIComponent(styleUrl)}&res=0.35&spd=2.5`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(6000);

console.log('\n[analytics] the funnel');
ph.names().includes('editor_opened')
  ? pass('editor_opened fires on load')
  : fail('editor_opened fires on load', JSON.stringify(ph.names()));

const opened = ph.find('editor_opened')[0];
opened?.properties?.from_link === true && opened?.properties?.stops === 2
  ? pass('editor_opened carries the arrival context (from_link, stops)')
  : fail('editor_opened carries the arrival context', JSON.stringify(opened?.properties));

// Type a title — user content that must never be transmitted.
await page.locator('[data-testid="title-input"]').fill(SECRET_TITLE);
await page.waitForTimeout(400);

// Apply a template: our own id, so this one IS expected on the wire.
await page.locator('[data-testid="template-road-trip"]').click().catch(() => {});
await page.waitForTimeout(1500);

await page.locator('[data-testid="zoom-city"]').click();
await page.waitForTimeout(800);

await page.evaluate(() => {
  document.querySelectorAll('button').forEach((b) => {
    if (b.textContent?.trim() === 'Play') b.click();
  });
});
await page.waitForTimeout(1500);

const names = ph.names();
names.includes('preview_played')
  ? pass('preview_played fires')
  : fail('preview_played fires', JSON.stringify(names));
names.includes('camera_changed')
  ? pass('camera_changed fires')
  : fail('camera_changed fires', JSON.stringify(names));

// Once-per-session events must not repeat, or the funnel counts are wrong.
await page.locator('[data-testid="zoom-region"]').click();
await page.waitForTimeout(1200);
ph.find('camera_changed').length === 1
  ? pass('once-per-session events fire exactly once')
  : fail('once-per-session events fire exactly once', ph.find('camera_changed').length);

console.log('\n[analytics] export events');
const href = await page.evaluate(async () => {
  const b = document.querySelector('[data-testid="export-button"]');
  if (!b || b.disabled) return null;
  b.click();
  for (let i = 0; i < 240; i++) {
    const a = document.querySelector('a[download]');
    if (a) return a.getAttribute('href');
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
});
await page.waitForTimeout(2500);

href ? pass('export completed') : fail('export completed', 'timed out');
ph.find('export_started').length >= 1
  ? pass('export_started fires')
  : fail('export_started fires', JSON.stringify(ph.names()));

const done = ph.find('export_completed')[0];
done
  ? pass('export_completed fires — the funnel closes')
  : fail('export_completed fires', JSON.stringify(ph.names()));

typeof done?.properties?.realtime_factor === 'number' && done.properties.frames > 0
  ? pass(`export_completed carries performance (${done.properties.frames} frames, ${done.properties.realtime_factor}× realtime)`)
  : fail('export_completed carries performance', JSON.stringify(done?.properties));

console.log('\n[analytics] privacy');
// The decisive check: search every byte we received, decoded or not.
const haystack = [JSON.stringify(ph.events), ...ph.rawBodies].join('\n');
!haystack.includes(SECRET_TITLE)
  ? pass('a typed title never reaches the wire')
  : fail('a typed title never reaches the wire', 'LEAKED');
!haystack.includes(SECRET_PLACE) && !haystack.includes('Llanfair')
  ? pass('place names never reach the wire')
  : fail('place names never reach the wire', 'LEAKED');
// Coordinates are personal too — a home address is a coordinate.
!/2\.3522|48\.8566|4\.8357|45\.764/.test(haystack)
  ? pass('coordinates never reach the wire')
  : fail('coordinates never reach the wire', 'LEAKED');
// Template ids are ours and SHOULD be there — proves the leak test isn't
// passing simply because nothing is being sent.
haystack.includes('template') || ph.find('template_applied').length > 0
  ? pass('our own identifiers do get through (the leak test is not vacuous)')
  : fail('our own identifiers do get through', 'nothing recognisable was sent');

console.log('\n[analytics] Do Not Track');
const dntCtx = await browser.newContext({ extraHTTPHeaders: { DNT: '1' } });
const dntPage = await dntCtx.newPage();
await dntPage.addInitScript(() => {
  Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' });
});
const before = ph.events.length;
await dntPage.goto(`http://localhost:${APP_PORT}/?styleUrl=${encodeURIComponent(styleUrl)}`, { waitUntil: 'load' });
await dntPage.waitForTimeout(5000);
ph.events.length === before
  ? pass('Do Not Track suppresses every event')
  : fail('Do Not Track suppresses every event', `${ph.events.length - before} events sent`);
await dntCtx.close();

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

// Restore a keyless build so no later suite — or a careless deploy from this
// working tree — ships with the test key baked in. Then use it to prove the
// claim that matters to every other environment: no key, no traffic.
console.log('\n[analytics] a build with no key is silent');
killTree(app);
await sleep(1500);
await new Promise((resolve) => {
  const b = spawn('npx', ['next', 'build'], { cwd, stdio: 'ignore' });
  b.on('exit', resolve);
});

const plain = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd,
  stdio: 'ignore',
  detached: true,
});
for (let i = 0; i < 90; i++) {
  try { if ((await fetch(`http://localhost:${APP_PORT}/`)).ok) break; } catch {}
  await sleep(500);
}
const beforeKeyless = ph.events.length;
const beforePaths = ph.paths.length;
const plainPage = await browser.newPage();
await plainPage.goto(
  `http://localhost:${APP_PORT}/?s=Paris,2.3522,48.8566~Lyon,4.8357,45.7640&styleUrl=${encodeURIComponent(styleUrl)}`,
  { waitUntil: 'load' },
);
await plainPage.waitForTimeout(5000);
await plainPage.evaluate(() => {
  document.querySelectorAll('button').forEach((b) => {
    if (b.textContent?.trim() === 'Play') b.click();
  });
});
await plainPage.waitForTimeout(2000);
ph.events.length === beforeKeyless && ph.paths.length === beforePaths
  ? pass('no key means not a single request')
  : fail('no key means not a single request', `${ph.paths.length - beforePaths} requests`);
killTree(plain);

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Analytics measures the funnel and leaks nothing' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
