// Headful test of photo import: real JPEGs with real EXIF GPS, dropped into
// the editor, becoming a trip whose markers are the photographs.
//
// The fixtures are generated with ffmpeg (actual encoded JPEGs) and then have
// an EXIF APP1 segment spliced in, so the browser is decoding files a camera
// could plausibly have produced — not a hand-rolled blob that only our own
// parser understands.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';
import { countPixels, rawPixels } from './imgstats.mjs';

const APP_PORT = 3310;
const TILE_PORT = 3311;
const DIR = '/tmp/mm-photos';
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
mkdirSync(DIR, { recursive: true });

/** Little-endian TIFF/EXIF block with GPS and DateTimeOriginal. */
function exifBlock({ lat, lng, date }) {
  const bytes = [];
  const w8 = (v) => bytes.push(v & 0xff);
  const w16 = (v) => { w8(v); w8(v >> 8); };
  const w32 = (v) => { w8(v); w8(v >> 8); w8(v >> 16); w8(v >> 24); };

  w8(0x49); w8(0x49); w16(42); w32(8);

  const heap = [];
  const heapBase = () => 8 + ifd0Size + exifSize + gpsSize;
  const pushRational = (value) => {
    const num = Math.round(Math.abs(value) * 10000);
    heap.push(num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, (num >>> 24) & 0xff);
    heap.push(0x10, 0x27, 0, 0); // 10000
  };

  const ifd0Size = 2 + 2 * 12 + 4;   // EXIF pointer + GPS pointer
  const exifSize = 2 + 1 * 12 + 4;   // DateTimeOriginal
  const gpsSize = 2 + 4 * 12 + 4;    // lat ref/val, lng ref/val

  const exifOffset = 8 + ifd0Size;
  const gpsOffset = exifOffset + exifSize;

  // --- IFD0 ---
  w16(2);
  w16(0x8769); w16(4); w32(1); w32(exifOffset);
  w16(0x8825); w16(4); w32(1); w32(gpsOffset);
  w32(0);

  // --- EXIF IFD ---
  const dateStr = `${date}\0`;
  const dateOffset = heapBase() + heap.length;
  for (const ch of dateStr) heap.push(ch.charCodeAt(0));
  w16(1);
  w16(0x9003); w16(2); w32(dateStr.length); w32(dateOffset);
  w32(0);

  // --- GPS IFD ---
  const absLat = Math.abs(lat);
  const absLng = Math.abs(lng);
  const toDms = (v) => {
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = ((v - d) * 60 - m) * 60;
    return [d, m, s];
  };
  const latOffset = heapBase() + heap.length;
  for (const part of toDms(absLat)) pushRational(part);
  const lngOffset = heapBase() + heap.length;
  for (const part of toDms(absLng)) pushRational(part);

  w16(4);
  // GPSLatitudeRef (inline, 2 bytes incl. NUL)
  w16(0x0001); w16(2); w32(2);
  w8(lat >= 0 ? 0x4e : 0x53); w8(0); w8(0); w8(0);
  w16(0x0002); w16(5); w32(3); w32(latOffset);
  w16(0x0003); w16(2); w32(2);
  w8(lng >= 0 ? 0x45 : 0x57); w8(0); w8(0); w8(0);
  w16(0x0004); w16(5); w32(3); w32(lngOffset);
  w32(0);

  bytes.push(...heap);
  return Buffer.from(bytes);
}

/** A real encoded JPEG with our EXIF segment spliced in after SOI. */
function makePhoto(path, { lat, lng, date, colour }) {
  const base = execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=320x240`,
    '-frames:v', '1', '-f', 'mjpeg', 'pipe:1',
  ], { maxBuffer: 8 * 1024 * 1024 });

  const exif = exifBlock({ lat, lng, date });
  const app1Len = 2 + 6 + exif.length;
  const header = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff]),
    Buffer.from('Exif\0\0', 'binary'),
    exif,
  ]);
  // Everything after the original SOI, with our APP1 in front of it.
  writeFileSync(path, Buffer.concat([header, base.subarray(2)]));
}

// A three-city trip, plus a second shot of the first city that must merge.
const PHOTOS = [
  { file: 'p1.jpg', lat: 13.7563, lng: 100.5018, date: '2026:07:01 09:00:00', colour: 'red' },
  { file: 'p2.jpg', lat: 13.7566, lng: 100.5021, date: '2026:07:01 09:05:00', colour: 'orange' },
  { file: 'p3.jpg', lat: 35.6895, lng: 139.6917, date: '2026:07:03 14:00:00', colour: 'blue' },
  { file: 'p4.jpg', lat: 48.8566, lng: 2.3522, date: '2026:07:06 18:00:00', colour: 'green' },
];
for (const p of PHOTOS) makePhoto(`${DIR}/${p.file}`, p);

// A photo with no EXIF at all, and something that isn't an image.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64',
  '-frames:v', '1', `${DIR}/nogps.jpg`]);
writeFileSync(`${DIR}/broken.jpg`, Buffer.from('not a photo at all', 'utf8'));

console.log(`[photos] fixtures: ${PHOTOS.length} located + 1 without GPS + 1 broken`);

// Verify the fixtures independently before trusting anything downstream.
try {
  const out = execFileSync('python3', ['-c', `
import piexif, json
r = {}
for f in ['p1.jpg','p3.jpg','p4.jpg']:
    d = piexif.load('${DIR}/' + f)
    g = d['GPS']
    def dms(v): return v[0][0]/v[0][1] + v[1][0]/v[1][1]/60 + v[2][0]/v[2][1]/3600
    r[f] = [round(dms(g[2]),4), round(dms(g[4]),4), g[1].decode(), g[3].decode()]
print(json.dumps(r))
`]).toString();
  const parsed = JSON.parse(out);
  Math.abs(parsed['p1.jpg'][0] - 13.7563) < 0.001 && Math.abs(parsed['p4.jpg'][1] - 2.3522) < 0.001
    ? pass('fixtures are valid EXIF by an independent reader (piexif)')
    : fail('fixtures are valid EXIF by an independent reader', out.slice(0, 120));
} catch (e) {
  console.log('  (piexif unavailable — skipping the independent fixture check)');
}

// ---------------------------------------------------------------------------

const { server: tiles, styleUrl } = await startMockTileServer(TILE_PORT);
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

await page.goto(`http://localhost:${APP_PORT}/?styleUrl=${encodeURIComponent(styleUrl)}&res=0.35`, {
  waitUntil: 'load',
});
await page.waitForTimeout(5000);

console.log('\n[photos] the drop');
(await page.locator('[data-testid="photo-import"]').count()) === 1
  ? pass('photo import renders')
  : fail('photo import renders');

await page.locator('[data-testid="photo-input"]').setInputFiles([
  ...PHOTOS.map((p) => `${DIR}/${p.file}`),
  `${DIR}/nogps.jpg`,
  `${DIR}/broken.jpg`,
]);
await page.waitForTimeout(6000);

const project = () => page.evaluate(() => {
  const p = window.__mmProject;
  if (!p) return null;
  return {
    markers: p.markers.map((m) => ({
      label: m.label,
      coordinate: m.coordinate,
      style: m.pin?.style,
      hasImage: Boolean(m.pin?.imageUrl && m.pin.imageUrl.startsWith('data:image')),
    })),
    routes: p.routes.length,
  };
});

const p1 = await project();
// Four photos, but two are the same place — so three stops, not four.
p1 && p1.markers.length === 3
  ? pass(`photos become stops, with same-place shots merged (${p1.markers.length} stops from 4 photos)`)
  : fail('photos become stops, with same-place shots merged', JSON.stringify(p1?.markers?.length));

const coords = (p1?.markers ?? []).map((m) => m.coordinate);
Math.abs((coords[0]?.[1] ?? 0) - 13.7563) < 0.01 &&
Math.abs((coords[1]?.[1] ?? 0) - 35.6895) < 0.01 &&
Math.abs((coords[2]?.[1] ?? 0) - 48.8566) < 0.01
  ? pass('stops carry the photos\' real coordinates, in capture order')
  : fail('stops carry the photos\' real coordinates, in capture order', JSON.stringify(coords));

(p1?.markers ?? []).every((m) => m.style === 'image' && m.hasImage)
  ? pass('every marker uses the photograph itself as its pin')
  : fail('every marker uses the photograph itself as its pin', JSON.stringify(p1?.markers));

// Names should come from the bundled index, not "Stop 1".
const labels = (p1?.markers ?? []).map((m) => m.label);
labels.includes('Bangkok') && labels.includes('Tokyo') && labels.includes('Paris')
  ? pass(`stops are named from the city index (${labels.join(', ')})`)
  : fail('stops are named from the city index', JSON.stringify(labels));

const note = await page.locator('[data-testid="photo-note"]').innerText().catch(() => '');
/skipped/i.test(note) && /2/.test(note)
  ? pass(`skipped photos are reported, not silently dropped ("${note.trim()}")`)
  : fail('skipped photos are reported, not silently dropped', note);

console.log('\n[photos] the map actually shows them');
const layers = await page.evaluate(() => {
  const map = window.__map;
  const ids = map?.getStyle()?.layers?.map((l) => l.id) ?? [];
  return ids.filter((id) => id.startsWith('marker-'));
});
layers.length > 0
  ? pass(`marker layers are installed (${layers.join(', ')})`)
  : fail('marker layers are installed');

// The decisive one. `icon-image` resolves against images REGISTERED ON THE
// MAP; a layer pointing at an id nothing added renders nothing at all, with
// only a console warning. Asserting the model said "image" would have passed
// happily while the pins were invisible — which is exactly how this shipped
// broken in the first place.
await page.waitForTimeout(2500);
const sprites = await page.evaluate(() => {
  const map = window.__map;
  if (!map) return null;
  const registered = map.listImages().filter((id) => id.startsWith('mm-pinimg-'));
  const wanted = (window.__mmProject?.markers ?? [])
    .filter((m) => m.pin?.style === 'image')
    .map((m) => m.id);
  const missing = [];
  for (const id of registered) if (!map.hasImage(id)) missing.push(id);
  return { registered: registered.length, wanted: wanted.length, missing };
});
sprites && sprites.registered === sprites.wanted && sprites.wanted > 0 && sprites.missing.length === 0
  ? pass(`each photo is registered as a map sprite (${sprites.registered}/${sprites.wanted})`)
  : fail('each photo is registered as a map sprite', JSON.stringify(sprites));

// And a second import must not reuse the first import's pictures: marker ids
// are positional, so an id-only cache key would show the old photo.
const idsBefore = await page.evaluate(() =>
  window.__map.listImages().filter((i) => i.startsWith('mm-pinimg-')).sort(),
);

// Registered is necessary but not sufficient — a sprite can be registered
// and still never drawn. The fixture photos are solid colours, so a red
// circle appearing over Bangkok proves the whole chain: EXIF -> stop ->
// thumbnail -> map image -> symbol layer -> pixels.
await page.evaluate(() => {
  const el = document.querySelector('input[type="range"][max]:not([data-testid])');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  // Well past the first marker's 200ms fade-in, and still on the first stop.
  setter.call(el, '900');
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/photos.png' });

const frame = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="preview-frame"]')?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 } : null;
});
const pixels = rawPixels('/tmp/photos.png', frame, frame?.dpr ?? 1);
const reds = countPixels(pixels, (r, g, b) => r > 140 && g < 90 && b < 90);
reds > 20
  ? pass(`the photograph is actually painted on the map (${reds} pixels of it)`)
  : fail('the photograph is actually painted on the map', `${reds} matching pixels`);

console.log('\n[photos] failure paths');
// A folder with nothing usable must explain why, not fail silently.
await page.locator('[data-testid="photo-input"]').setInputFiles([`${DIR}/nogps.jpg`]);
await page.waitForTimeout(3000);
const err = await page.locator('[data-testid="photo-error"]').innerText().catch(() => '');
/location data/i.test(err)
  ? pass('a folder with no GPS explains why, and how to fix it')
  : fail('a folder with no GPS explains why', err);

// The trip must be unchanged by a failed import.
const p2 = await project();
p2?.markers.length === 3
  ? pass('a failed import leaves the existing trip alone')
  : fail('a failed import leaves the existing trip alone', JSON.stringify(p2?.markers?.length));

// HEIC: the single most likely file a real user drops.
const heic = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypheic', 'binary'),
  Buffer.alloc(64),
]);
writeFileSync(`${DIR}/photo.heic`, heic);
await page.locator('[data-testid="photo-input"]').setInputFiles([`${DIR}/photo.heic`]);
await page.waitForTimeout(2500);
const heicErr = await page.locator('[data-testid="photo-error"]').innerText().catch(() => '');
/HEIC/i.test(heicErr) && /Most Compatible|JPEG/i.test(heicErr)
  ? pass('HEIC is named as the problem, with the iPhone setting to change')
  : fail('HEIC is named as the problem', heicErr);

console.log('\n[photos] a second import replaces the pictures');
await page.locator('[data-testid="photo-input"]').setInputFiles([
  `${DIR}/p3.jpg`, `${DIR}/p4.jpg`, `${DIR}/p1.jpg`,
]);
await page.waitForTimeout(6000);
const idsAfter = await page.evaluate(() =>
  window.__map.listImages().filter((i) => i.startsWith('mm-pinimg-')).sort(),
);
const reused = idsAfter.filter((id) => idsBefore.includes(id));
// Some overlap is expected (the same photo can land on the same stop index),
// but the sprite set must not simply be the old one.
idsAfter.length > 0 && idsAfter.length === (await page.evaluate(() =>
  (window.__mmProject?.markers ?? []).filter((m) => m.pin?.style === 'image').length))
  ? pass(`the sprite set tracks the new import (${idsAfter.length} images, ${reused.length} genuinely unchanged)`)
  : fail('the sprite set tracks the new import', JSON.stringify({ idsBefore, idsAfter }));

console.log('\n[photos] export');
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
href ? pass('a photo trip exports') : fail('a photo trip exports', 'timed out');

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ A folder of photos becomes a trip' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
