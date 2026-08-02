// Headful test of annotations: text, arrows and shapes placed by clicking
// the map.
//
// Placement is the interesting part. The map is built with
// `interactive: false` — that is what keeps preview and export identical —
// so clicks cannot come from MapLibre's handlers. A transparent overlay
// unprojects them instead, which means the coordinate maths (including
// dividing out the preview's CSS scale) is ours and can be wrong. So the
// tests check that a click lands where it was aimed, not merely that
// something appeared.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { click, exists, openPanel, reveal, setRange } from './ui.mjs';
import { startMockTileServer } from './mock-tileserver.mjs';
import { countPixels, rawPixels } from './imgstats.mjs';

const APP_PORT = 3350;
const TILE_PORT = 3351;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

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
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[mm-map-error]') && !t.includes('elevation-tiles-prod')) pageErrors.push(t);
});

await page.goto(
  `http://localhost:${APP_PORT}/?s=Paris,2.3522,48.8566~Warsaw,21.0122,52.2297&styleUrl=${encodeURIComponent(styleUrl)}&zm=country&res=0.4`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);

/** Click a point given as a fraction of the preview frame. */
const clickFrame = async (fx, fy) => {
  const box = await page.locator('[data-testid="preview-frame"]').boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(500);
};

/** What the map is showing at the centre of the preview, for comparison. */
const centreLngLat = () =>
  page.evaluate(() => {
    const c = window.__map.getCenter();
    return [c.lng, c.lat];
  });

const compiled = () => page.evaluate(() => window.__mmProject?.annotations ?? []);

console.log('\n[annotate] placing text');
(await (await reveal(page, 'annotate-panel')).count()) === 1
  ? pass('annotate panel renders')
  : fail('annotate panel renders');

await click(page, 'annotate-add-text');
await page.waitForTimeout(600);
(await (await reveal(page, 'annotate-placing')).count()) === 1
  ? pass('choosing a kind enters placement mode')
  : fail('choosing a kind enters placement mode');
(await page.locator('[data-testid="placement-overlay"]').count()) === 1
  ? pass('a click overlay appears over the map')
  : fail('a click overlay appears over the map');

// Dead centre: the coordinate must come back as the map's own centre. This
// is the assertion that catches a missing CSS-scale division — with the
// preview scaled to ~0.8, an unscaled click lands well off to one side.
const centre = await centreLngLat();
await clickFrame(0.5, 0.5);
await page.waitForTimeout(1200);

const afterText = await compiled();
afterText.length === 1
  ? pass('one click places a text annotation')
  : fail('one click places a text annotation', JSON.stringify(afterText.length));

if (afterText[0]) {
  const [lng, lat] = afterText[0].coordinates[0];
  const dLng = Math.abs(lng - centre[0]);
  const dLat = Math.abs(lat - centre[1]);
  dLng < 0.6 && dLat < 0.6
    ? pass(`a click at the centre lands at the map centre (Δ ${dLng.toFixed(3)}, ${dLat.toFixed(3)})`)
    : fail('a click at the centre lands at the map centre', `${lng},${lat} vs ${centre}`);
}

(await page.locator('[data-testid="placement-overlay"]').count()) === 0
  ? pass('placement ends once the last point is set')
  : fail('placement ends once the last point is set');

await (await reveal(page, 'annotate-0-text')).fill('Front line');
await page.waitForTimeout(1200);
(await compiled())[0]?.text === 'Front line'
  ? pass('editing the label reaches the compiled scene')
  : fail('editing the label reaches the compiled scene', (await compiled())[0]?.text);

console.log('\n[annotate] the text is actually drawn');
const layers = await page.evaluate(() =>
  (window.__map?.getStyle()?.layers ?? []).filter((l) => l.id.startsWith('annotation-')).map((l) => l.id),
);
layers.includes('annotation-text') && layers.includes('annotation-line')
  ? pass(`annotation layers are installed (${layers.length})`)
  : fail('annotation layers are installed', JSON.stringify(layers));

const pointFeatures = await page.evaluate(() => {
  const src = window.__map.getSource('mm-ann-point');
  const d = src?.serialize?.().data ?? src?._data;
  return (d?.features ?? []).map((f) => ({ kind: f.properties.kind, text: f.properties.text, op: f.properties.opacity }));
});
pointFeatures.length === 1 && pointFeatures[0].text === 'Front line' && pointFeatures[0].op > 0
  ? pass(`the label reaches the map source, visible (opacity ${pointFeatures[0].op.toFixed(2)})`)
  : fail('the label reaches the map source, visible', JSON.stringify(pointFeatures));

console.log('\n[annotate] a two-click arrow');
await click(page, 'annotate-add-arrow');
await page.waitForTimeout(500);
await clickFrame(0.3, 0.4);
// One click is not enough for a two-point shape.
(await page.locator('[data-testid="placement-overlay"]').count()) === 1
  ? pass('an arrow waits for its second click')
  : fail('an arrow waits for its second click');
await clickFrame(0.7, 0.6);
await page.waitForTimeout(1500);

const anns = await compiled();
anns.length === 2 && anns[1].coordinates.length === 2
  ? pass('two clicks place an arrow with both ends')
  : fail('two clicks place an arrow with both ends', JSON.stringify(anns.map((a) => a.coordinates.length)));

// The arrow must run left-to-right in longitude, matching the clicks.
if (anns[1]?.coordinates.length === 2) {
  anns[1].coordinates[1][0] > anns[1].coordinates[0][0]
    ? pass('the arrow points the way it was drawn')
    : fail('the arrow points the way it was drawn', JSON.stringify(anns[1].coordinates));
}

const lineFeatures = await page.evaluate(() => {
  const src = window.__map.getSource('mm-ann-line');
  const d = src?.serialize?.().data ?? src?._data;
  return (d?.features ?? []).length;
});
// Shaft plus two barbs once the draw-on is complete.
lineFeatures >= 3
  ? pass(`the arrowhead is drawn as well as the shaft (${lineFeatures} line features)`)
  : fail('the arrowhead is drawn as well as the shaft', lineFeatures);

console.log('\n[annotate] it paints');
const frameBox = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="preview-frame"]')?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 } : null;
});
await page.screenshot({ path: '/tmp/annotate-on.png' });

// Remove both and compare: the difference is the annotations and nothing else.
await click(page, 'annotate-remove-1');
await page.waitForTimeout(600);
await click(page, 'annotate-remove-0');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/annotate-off.png' });

const differing = (() => {
  const a = rawPixels('/tmp/annotate-on.png', frameBox, frameBox?.dpr ?? 1).data;
  const b = rawPixels('/tmp/annotate-off.png', frameBox, frameBox?.dpr ?? 1).data;
  let n = 0;
  for (let i = 0; i + 2 < Math.min(a.length, b.length); i += 3) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++;
  }
  return n;
})();
differing > 60
  ? pass(`annotations change the rendered map (${differing} pixels)`)
  : fail('annotations change the rendered map', `${differing} pixels`);

(await compiled()).length === 0
  ? pass('removing them clears the scene')
  : fail('removing them clears the scene');

console.log('\n[annotate] shapes');
await click(page, 'annotate-add-circle');
await page.waitForTimeout(400);
await clickFrame(0.5, 0.5);
await clickFrame(0.62, 0.5);
await page.waitForTimeout(1500);

const fills = await page.evaluate(() => {
  const src = window.__map.getSource('mm-ann-fill');
  const d = src?.serialize?.().data ?? src?._data;
  const f = d?.features?.[0];
  return f ? { type: f.geometry.type, ring: f.geometry.coordinates[0].length, op: f.properties.fillOpacity } : null;
});
fills && fills.type === 'Polygon' && fills.ring > 30
  ? pass(`a circle compiles to a real polygon (${fills.ring} points)`)
  : fail('a circle compiles to a real polygon', JSON.stringify(fills));

console.log('\n[annotate] timing');
// Placing already selects and opens the new annotation, so clicking its
// header here would toggle the editor shut and the slider would not exist.
await setRange(page, 'annotate-0-enter', 0.6);
await page.waitForTimeout(1000);

const opacityAt = async (frac) => {
  await page.evaluate((f) => {
    const el = document.querySelector('input[type="range"][max]:not([data-testid])');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(Math.round(Number(el.max) * f)));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, frac);
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const src = window.__map.getSource('mm-ann-fill');
    const d = src?.serialize?.().data ?? src?._data;
    return d?.features?.[0]?.properties?.fillOpacity ?? 0;
  });
};

const early = await opacityAt(0.2);
const late = await opacityAt(0.95);
early === 0 && late > 0
  ? pass(`the shape appears at its entrance (t=20% → ${early}, t=95% → ${late.toFixed(2)})`)
  : fail('the shape appears at its entrance', `${early} / ${late}`);

console.log('\n[annotate] cancelling');
await click(page, 'annotate-add-rect');
await page.waitForTimeout(400);
const beforeCancel = (await compiled()).length;
await click(page, 'annotate-cancel');
await page.waitForTimeout(1200);
(await compiled()).length === beforeCancel &&
(await page.locator('[data-testid="placement-overlay"]').count()) === 0
  ? pass('cancelling drops the half-placed shape')
  : fail('cancelling drops the half-placed shape', `${beforeCancel} → ${(await compiled()).length}`);

console.log('\n[annotate] survives a style switch');
await openPanel(page, 'style');
await page.selectOption('select', 'minimal');
await page.waitForTimeout(5000);
const afterSwitch = await page.evaluate(
  () => (window.__map?.getStyle()?.layers ?? []).filter((l) => l.id.startsWith('annotation-')).length,
);
afterSwitch >= 5
  ? pass('annotation layers are reinstalled after a style change')
  : fail('annotation layers are reinstalled after a style change', afterSwitch);

console.log('\n[annotate] export');
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
href ? pass('an annotated map exports') : fail('an annotated map exports', 'timed out');

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Annotations work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
