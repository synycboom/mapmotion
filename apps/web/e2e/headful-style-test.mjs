// Headful (real Chromium window under Xvfb) verification of the remote-style
// boot path — the one the blank-basemap bug lived in.
//
// The sandbox proxy 403s tiles.openfreemap.org, so we point the editor at a
// local server that mirrors OpenFreeMap's structure exactly:
//   remote style URL -> vector source -> TileJSON hop -> real MVT tiles
//
// Pass criteria (all must hold):
//   1. vector .pbf tiles are actually requested and return 200
//   2. no MapLibre 'error' events ([mm-map-error])
//   3. the rendered canvas is NOT a flat single colour (i.e. geometry drew)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';
import { rawStats } from './imgstats.mjs';

const APP_PORT = 3120;
const TILE_PORT = 3210;

const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));
if (!exe) {
  console.error('no chromium found');
  process.exit(1);
}

const { server: tileServer, styleUrl } = await startMockTileServer(TILE_PORT);
console.log(`Mock tile server up: ${styleUrl}`);

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
const cleanup = () => {
  try { app.kill('SIGTERM'); } catch {}
  try { tileServer.close(); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${APP_PORT}/`)).ok) break; } catch {}
  await sleep(500);
}
console.log('App server up.');

// HEADFUL: a real browser window inside the Xvfb display, with a CDP
// endpoint exposed. Not --headless.
const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: [
    '--remote-debugging-port=9222',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--window-size=1400,900',
  ],
});
console.log('Headful Chromium launched (CDP on :9222).');

const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const mapErrors = [];
const tileRequests = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[mm-map-error]')) mapErrors.push(t);
});
page.on('pageerror', (e) => mapErrors.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/t/') && u.endsWith('.pbf')) tileRequests.push({ u, s: r.status() });
});

const target = `http://localhost:${APP_PORT}/?styleUrl=${encodeURIComponent(styleUrl)}`;
console.log(`Navigating: ${target}`);
await page.goto(target, { waitUntil: 'load', timeout: 60_000 });

// Give the map time to fetch TileJSON + tiles and paint.
await page.waitForTimeout(9000);

// Screenshot the MAP AREA ONLY. Note: sampling the WebGL canvas directly via
// drawImage() from an arbitrary task returns an empty (black) buffer because
// MapLibre runs with preserveDrawingBuffer:false — the page screenshot is the
// real composited output, so that's what we measure.
const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
await page.screenshot({ path: '/tmp/headful-style.png' });
await page.screenshot({ path: '/tmp/headful-map.png', clip: box });
const shot = rawStats('/tmp/headful-map.png');

const diag = await page.evaluate(() => window.__mmDiag?.() ?? 'no diag');

console.log('\n--- window.__mmDiag() ---');
console.log(JSON.stringify(diag, null, 2));
console.log('\n--- rendered map pixels (composited screenshot) ---');
console.log(JSON.stringify(shot, null, 2));
console.log('\n--- vector tile requests ---');
console.log(`count=${tileRequests.length}`, tileRequests.slice(0, 3));
console.log('--- map errors ---');
console.log(mapErrors.length ? mapErrors : 'none');

// Now prove the EXPORT path also captures real pixels with a remote vector
// style (the exporter drawImage()s the same WebGL canvas).
console.log('\nRunning an export through the remote style…');
const exported = await page.evaluate(async () => {
  const w = window;
  w.__t0 = performance.now();
  document.querySelectorAll('button').forEach((b) => {
    if (b.textContent?.startsWith('Export')) b.click();
  });
  // Wait for the download link to appear (max 4 min).
  for (let i = 0; i < 240; i++) {
    const a = document.querySelector('a[download]');
    if (a) return { href: a.getAttribute('href'), text: document.body.innerText.slice(-400) };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
});

let videoStats = null;
if (exported?.href) {
  const b64 = await page.evaluate(async (href) => {
    const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, exported.href);
  const out = '/tmp/headful-export.webm';
  writeFileSync(out, Buffer.from(b64, 'base64'));
  // Sample a frame from the middle of the animation.
  videoStats = rawStats(out, { frameSelect: 6 });
  console.log('--- exported video, frame @6s ---');
  console.log(JSON.stringify(videoStats, null, 2));
} else {
  console.log('--- export did not complete ---');
}

await browser.close();
cleanup();

const ok200 = tileRequests.filter((t) => t.s === 200).length;
const checks = {
  'vector tiles requested & 200': ok200 > 0,
  'no map errors': mapErrors.length === 0,
  'rendered map is not flat': shot.distinctColors > 20 && shot.stddev > 5,
  'export produced a video': !!videoStats,
  'exported frames are not blank': !!videoStats && videoStats.distinctColors > 20 && videoStats.stddev > 5,
};
console.log('\n=== RESULT ===');
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
const allPass = Object.values(checks).every(Boolean);
console.log(allPass ? '\n✅ Remote-style boot path renders correctly' : '\n❌ Remote-style boot path is broken');
process.exit(allPass ? 0 : 1);
