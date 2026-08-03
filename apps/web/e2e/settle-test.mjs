// Does the export stay complete when tiles take real network time to arrive?
//
// Every other suite runs against a localhost tile server that answers in
// under a millisecond, so `settle()` has never once had to actually wait.
// That is why nineteen green suites and a 0.41× realtime figure coexisted
// with a user reporting a stuttering export: production talks to a CDN, and
// a fresh viewport wants a dozen tiles at 40–300ms each.
//
// This suite injects that latency and then looks at EVERY frame of the
// resulting video, because tile pop-in is invisible to a single-frame check
// by construction — the frames either side of a hole both look perfect.
//
// Pass criteria:
//   1. the export completes at all
//   2. no frame is measurably emptier than both of its neighbours
//   3. the exporter reports zero frames captured while still loading
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';
import { frameDiffs, frameSeries, popInFrames, rawStats, stalledFrames } from './imgstats.mjs';

const APP_PORT = 3128;
const TILE_PORT = 3218;

// A distant CDN edge, not a bad one. OpenFreeMap serves from Europe and this
// product's first reported stutter came from Thailand, where the round trip
// is 250–350ms before queuing. A dozen tiles for a fresh viewport over six
// concurrent connections lands squarely on the 3000ms settle budget — which
// is the whole point: the failure is not exotic, it is what half the planet
// gets by default.
const TILE_LATENCY_MS = 900;
const TILE_JITTER_MS = 600;

const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));
if (!exe) {
  console.error('no chromium found');
  process.exit(1);
}

const { server: tileServer, styleUrl, stats: tileStats } = await startMockTileServer(
  TILE_PORT,
  { tileLatencyMs: TILE_LATENCY_MS, jitterMs: TILE_JITTER_MS, tileGrid: true },
);
console.log(`Mock tile server up (${TILE_LATENCY_MS}±${TILE_JITTER_MS}ms per tile): ${styleUrl}`);

const killTree = (child) => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
};

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
const cleanup = () => {
  killTree(app);
  try { tileServer.close(); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${APP_PORT}/`)).ok) break; } catch {}
  await sleep(500);
}
console.log('App server up.');

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--window-size=1200,800',
  ],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const mapErrors = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[mm-map-error]')) mapErrors.push(t);
});
page.on('pageerror', (e) => mapErrors.push(`pageerror: ${e.message}`));

// Getting this route wrong is how the first two attempts at this suite passed
// while proving nothing:
//   - Three European capitals framed the camera at zoom ~5, where the entire
//     planet is a couple of dozen tiles. Ten requests for the whole export.
//   - Three Paris landmarks held zoom 13 but spanned 3km, which at that zoom
//     is a single tile. Also ten requests.
// A route needs BOTH a high zoom and real ground covered before a fly-through
// asks for tiles nobody has cached. Six stops strung 25km across greater
// Paris keeps the auto-framing near zoom 12 and marches the viewport over
// fresh tiles the whole way. Full resolution, because a 1280×720 viewport
// needs a dozen tiles where a 512×288 one needs four.
const stops = [
  'La Defense,2.2380,48.8925',
  'Arc de Triomphe,2.2950,48.8738',
  'Louvre,2.3376,48.8606',
  'Bastille,2.3692,48.8532',
  'Pere Lachaise,2.3934,48.8614',
  'Vincennes,2.4350,48.8447',
].join('~');
// No camera parameters at all beyond the stops. The report this suite exists
// for was made against the defaults, so the defaults are what it has to
// exercise — including the dwell orbit, which is what guarantees that no two
// consecutive frames of a healthy export are ever identical. Pin an orbit
// here and the suite stops being able to see a regression in the default.
//
// MM_LEGACY=1 restores the pre-fix camera defaults — a static dwell and an
// ease-in-out on every leg — through the ordinary URL parameters. It exists
// so this suite can be shown to have teeth on demand rather than on faith.
// Under it, 109 of 288 animated frames come back frozen and median movement
// drops from 3.96 to 0.69; without it, zero and 3.96. Nothing in the app
// knows about the variable.
const legacyCamera = process.env.MM_LEGACY ? '&orb=0&ez=c' : '';
const target =
  `http://localhost:${APP_PORT}/?styleUrl=${encodeURIComponent(styleUrl)}` +
  `&s=${encodeURIComponent(stops)}&spd=2${legacyCamera}`;

console.log('Navigating…');
await page.goto(target, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => !!window.__map, null, { timeout: 60_000 });
// Let the first viewport finish before the export's own pre-warm, so we are
// measuring per-frame settling and not cold-start.
await page.waitForTimeout(8000);

console.log('Exporting under latency (this is meant to be slow)…');
const t0 = Date.now();
const exported = await page.evaluate(async () => {
  document.querySelectorAll('button').forEach((b) => {
    if (b.textContent?.startsWith('Export')) b.click();
  });
  for (let i = 0; i < 600; i++) {
    const a = document.querySelector('a[download]');
    if (a) return { href: a.getAttribute('href') };
    if (window.__exportResult && window.__exportResult.ok === false) {
      return { error: String(window.__exportResult.error) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
});
const exportWallS = Math.round((Date.now() - t0) / 100) / 10;

let out = null;
if (exported?.href) {
  const b64 = await page.evaluate(async (href) => {
    const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }, exported.href);
  out = '/tmp/settle-export.webm';
  writeFileSync(out, Buffer.from(b64, 'base64'));
}

const result = await page.evaluate(() => window.__exportResult ?? null);
// compileTrip runs the video on past its last camera keyframe so it ends on a
// held shot. Those trailing frames are identical by design and have to be
// excluded from the repeat check, or the feature reads as the bug.
const heldFrom = await page.evaluate(() => {
  const p = window.__mmProject;
  if (!p) return null;
  const lastKf = p.camera[p.camera.length - 1];
  return Math.round((lastKf.tMs / 1000) * p.format.fps);
});
await browser.close();
cleanup();

console.log('\n--- export result ---');
console.log(JSON.stringify(result, null, 2));
console.log(`wall time: ${exportWallS}s · tiles served: ${tileStats.tiles}`);

if (!out) {
  console.log('\n=== RESULT ===');
  console.log(`FAIL  export produced a video  (${exported?.error ?? 'timed out'})`);
  process.exit(1);
}

// 240x135 rather than the 96x54 default: a slow arrival moves a couple of
// pixels at output resolution, and at 96 wide that averages away into
// nothing, which makes a correct frame look like a repeat.
const frames = frameSeries(out, { w: 240, h: 135 });
const popIn = popInFrames(frames);
const animatedEnd = heldFrom ?? frames.length;
const stalled = stalledFrames(frames).filter((s) => s.index <= animatedEnd);
const diffs = frameDiffs(frames);
const overall = rawStats(out, { frameSelect: 2 });

// Report the shape of the signal, not just the verdict: if this suite ever
// fails again the numbers below are what makes it diagnosable.
const darks = frames.map((f) => f.darkFrac);
console.log('\n--- per-frame background fraction ---');
console.log(
  `frames=${frames.length} min=${(Math.min(...darks) * 100).toFixed(1)}% ` +
    `max=${(Math.max(...darks) * 100).toFixed(1)}% ` +
    `mean=${((darks.reduce((a, b) => a + b, 0) / darks.length) * 100).toFixed(1)}%`,
);
if (popIn.length) {
  console.log(`\n--- ${popIn.length} frame(s) emptier than both neighbours ---`);
  for (const p of popIn.slice(0, 12)) {
    console.log(`  frame ${p.index}: +${p.delta}% background vs neighbours`);
  }
  if (popIn.length > 12) console.log(`  … and ${popIn.length - 12} more`);
}

const body = diffs.filter((d) => d.index <= animatedEnd).map((d) => d.diff);
const tail = diffs.filter((d) => d.index > animatedEnd).map((d) => d.diff);
console.log('\n--- frame-to-frame movement ---');
console.log(
  `animated frames 1-${animatedEnd}: min=${Math.min(...body).toFixed(3)} ` +
    `median=${body.slice().sort((a, b) => a - b)[body.length >> 1].toFixed(2)} ` +
    `max=${Math.max(...body).toFixed(2)}`,
);
if (tail.length) {
  console.log(
    `held end frames ${animatedEnd + 1}-${frames.length - 1}: max=${Math.max(...tail).toFixed(3)}`,
  );
}
if (stalled.length) {
  console.log(`\n--- ${stalled.length} frame(s) identical to the one before ---`);
  console.log(`  at: ${stalled.slice(0, 20).map((s) => `${s.index}(${s.diff})`).join(', ')}`);
}

const incomplete = Number(result?.incompleteFrames ?? -1);

const checks = {
  'export produced a video': !!out,
  'no map errors': mapErrors.length === 0,
  'frames are not blank': overall.distinctColors > 20 && overall.stddev > 5,
  'no tile pop-in between neighbouring frames': popIn.length === 0,
  // With the default dwell orbit the camera is always moving, so inside the
  // animated body every frame must differ from the last. A repeat means the
  // video genuinely froze — which is what "the export lags" meant.
  'no frozen frames in the animated body': stalled.length === 0,
  // -1 means the exporter does not report this yet, which is itself the bug:
  // it cannot know whether it captured a half-drawn frame.
  'exporter reports zero incomplete frames': incomplete === 0,
};

console.log('\n=== RESULT ===');
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
if (mapErrors.length) console.log('map errors:', mapErrors.slice(0, 5));
const allPass = Object.values(checks).every(Boolean);
console.log(
  allPass
    ? '\n✅ Export stays complete under realistic tile latency'
    : '\n❌ Export drops frames when tiles are slow',
);
process.exit(allPass ? 0 : 1);
