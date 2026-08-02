// Headful test of region highlighting.
//
// A fill is only worth anything if it lands on the right countries, animates
// in, and sits UNDER the place labels. All three are checked against the map
// and against pixels — "a layer with the right filter exists" would pass
// happily with the fill painted over every label, or with an opacity of zero.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { click, exists, openPanel, reveal, setRange } from './ui.mjs';
import { startMockTileServer } from './mock-tileserver.mjs';
import { countPixels, rawPixels } from './imgstats.mjs';

const APP_PORT = 3330;
const TILE_PORT = 3331;
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

// The boundary file is served by the app itself, so verify it before relying
// on anything downstream — a 404 here would look like a rendering bug.
console.log('[regions] boundary data');
const geo = await (await fetch(`http://localhost:${APP_PORT}/data/countries.json`)).json();
Array.isArray(geo.features) && geo.features.length > 150
  ? pass(`boundary file serves ${geo.features.length} countries`)
  : fail('boundary file serves countries', JSON.stringify(geo).slice(0, 100));

const codes = new Set(geo.features.map((f) => f.properties?.a3));
['FRA', 'DEU', 'THA', 'USA', 'BRA'].every((c) => codes.has(c))
  ? pass('the codes the groups use are all present')
  : fail('the codes the groups use are all present');

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

// Europe-centred so an EU fill occupies most of the frame.
await page.goto(
  `http://localhost:${APP_PORT}/?s=Paris,2.3522,48.8566~Warsaw,21.0122,52.2297&styleUrl=${encodeURIComponent(styleUrl)}&zm=continent&res=0.4`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);

const layerInfo = () =>
  page.evaluate(() => {
    const layers = window.__map?.getStyle()?.layers ?? [];
    const ids = layers.map((l) => l.id);
    const fill = layers.find((l) => l.id.startsWith('region-fill-'));
    const firstSymbol = layers.findIndex((l) => l.type === 'symbol' && !l.id.startsWith('marker-'));
    return {
      fills: ids.filter((i) => i.startsWith('region-fill-')),
      lines: ids.filter((i) => i.startsWith('region-line-')),
      fillIndex: ids.findIndex((i) => i.startsWith('region-fill-')),
      firstSymbol,
      filter: fill?.filter ?? null,
      opacity: fill
        ? window.__map.getPaintProperty(fill.id, 'fill-opacity')
        : null,
    };
  });

console.log('\n[regions] adding a group');
(await (await reveal(page, 'region-panel')).count()) === 1
  ? pass('region panel renders')
  : fail('region panel renders');

await click(page, 'region-group-eu');
// Boundary geometry is a network fetch on first use.
await page.waitForTimeout(4000);

const compiled = await page.evaluate(() => {
  const r = window.__mmProject?.regions ?? [];
  return r.map((x) => ({ id: x.id, codes: x.codes.length, group: x.groupId }));
});
compiled.length === 1 && compiled[0].codes === 27
  ? pass(`the EU compiles to 27 countries (${compiled[0].group})`)
  : fail('the EU compiles to 27 countries', JSON.stringify(compiled));

const info = await layerInfo();
info.fills.length === 1 && info.lines.length === 1
  ? pass('a fill and an outline layer are installed')
  : fail('a fill and an outline layer are installed', JSON.stringify(info.fills));

// Under the labels: a highlight that buries every city name is worse than no
// highlight at all.
info.firstSymbol >= 0 && info.fillIndex >= 0 && info.fillIndex < info.firstSymbol
  ? pass(`the fill sits beneath the place labels (${info.fillIndex} < ${info.firstSymbol})`)
  : fail('the fill sits beneath the place labels', JSON.stringify({ fill: info.fillIndex, sym: info.firstSymbol }));

console.log('\n[regions] it actually paints');
await page.waitForTimeout(2500);
const frame = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="preview-frame"]')?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 } : null;
});
await page.screenshot({ path: '/tmp/regions-on.png' });

/**
 * Mean red-minus-blue over the map area.
 *
 * Not a match against #e8590c: at 35% opacity over this basemap's cream land
 * the fill blends to a pale peach, whose channels are nowhere near the pure
 * colour. Testing for the literal swatch found zero pixels while the fill was
 * rendering perfectly well. Warmth is what actually changes, and it survives
 * any blend and any basemap.
 */
const warmth = (file) => {
  const { data } = rawPixels(file, frame, frame?.dpr ?? 1);
  let r = 0;
  let b = 0;
  const n = data.length / 3;
  for (let i = 0; i + 2 < data.length; i += 3) {
    r += data[i];
    b += data[i + 2];
  }
  return n ? (r - b) / n : 0;
};

// Remove it and re-shoot: the difference is the fill, and nothing else.
await click(page, 'region-remove-0');
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/regions-off.png' });

const withFill = warmth('/tmp/regions-on.png');
const withoutFill = warmth('/tmp/regions-off.png');
withFill - withoutFill > 3
  ? pass(`the highlight visibly warms the map (${withoutFill.toFixed(1)} → ${withFill.toFixed(1)})`)
  : fail('the highlight visibly warms the map', `${withoutFill.toFixed(1)} → ${withFill.toFixed(1)}`);

const changed = (() => {
  const a = rawPixels('/tmp/regions-on.png', frame, frame?.dpr ?? 1).data;
  const b = rawPixels('/tmp/regions-off.png', frame, frame?.dpr ?? 1).data;
  let n = 0;
  for (let i = 0; i + 2 < Math.min(a.length, b.length); i += 3) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
  }
  return n;
})();
changed > 400
  ? pass(`and covers a real area of it (${changed} pixels differ)`)
  : fail('and covers a real area of it', `${changed} pixels differ`);

console.log('\n[regions] animation and options');
await click(page, 'region-group-nordics');
await page.waitForTimeout(3000);

// Enter halfway through: invisible at the start, visible at the end.
await setRange(page, 'region-0-enter', 0.5);
await page.waitForTimeout(1200);

const opacityAt = async (frac) => {
  await page.evaluate((f) => {
    const el = document.querySelector('input[type="range"][max]:not([data-testid])');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(Math.round(Number(el.max) * f)));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, frac);
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const id = (window.__map?.getStyle()?.layers ?? []).find((l) =>
      l.id.startsWith('region-fill-'),
    )?.id;
    return id ? window.__map.getPaintProperty(id, 'fill-opacity') : -1;
  });
};

const early = await opacityAt(0.1);
const late = await opacityAt(0.95);
early === 0 && late > 0
  ? pass(`the fill fades in at its entrance (t=10% → ${early}, t=95% → ${late.toFixed(2)})`)
  : fail('the fill fades in at its entrance', `${early} / ${late}`);

await setRange(page, 'region-0-opacity', 0.8);
const strong = await opacityAt(0.95);
Math.abs(strong - 0.8) < 0.05
  ? pass(`the opacity control reaches the paint property (${strong.toFixed(2)})`)
  : fail('the opacity control reaches the paint property', strong);

console.log('\n[regions] several at once');
await click(page, 'region-group-g7');
await page.waitForTimeout(3000);
const two = await layerInfo();
two.fills.length === 2
  ? pass('two highlights coexist as separate layers')
  : fail('two highlights coexist as separate layers', JSON.stringify(two.fills));

const colours = await page.evaluate(() =>
  (window.__map?.getStyle()?.layers ?? [])
    .filter((l) => l.id.startsWith('region-fill-'))
    .map((l) => window.__map.getPaintProperty(l.id, 'fill-color')),
);
new Set(colours).size === 2
  ? pass(`a second highlight gets its own colour (${colours.join(', ')})`)
  : fail('a second highlight gets its own colour', JSON.stringify(colours));

console.log('\n[regions] custom country picking');
await click(page, 'region-add-custom');
await page.waitForTimeout(1200);
await click(page, 'region-2-pick');
await page.waitForTimeout(1500);
// The list shows the first 40 alphabetically until you search, so a country
// late in the alphabet has to be searched for.
await (await reveal(page, 'region-2-search')).fill('Thai');
await page.waitForTimeout(600);
(await (await reveal(page, 'region-country-THA')).count()) === 1
  ? pass('the country picker lists countries from the boundary file')
  : fail('the country picker lists countries from the boundary file');
await click(page, 'region-country-THA');
await page.waitForTimeout(2000);
const custom = await page.evaluate(() => {
  const r = window.__mmProject?.regions ?? [];
  return r[r.length - 1]?.codes ?? [];
});
custom.includes('THA')
  ? pass('picking a country compiles it into the track')
  : fail('picking a country compiles it into the track', JSON.stringify(custom));

console.log('\n[regions] survives a style switch');
await openPanel(page, 'style');
await page.selectOption('select', 'minimal');
await page.waitForTimeout(5000);
const afterSwitch = await layerInfo();
afterSwitch.fills.length === 3
  ? pass('highlights are reinstalled after a style change')
  : fail('highlights are reinstalled after a style change', JSON.stringify(afterSwitch.fills));

console.log('\n[regions] export');
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
href ? pass('a highlighted map exports') : fail('a highlighted map exports', 'timed out');

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Region highlighting works' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
