// Headful test of the project library. The valuable cases are the ugly ones:
// an imported track surviving a round-trip (the thing URLs can't carry), and
// corrupt/absent storage not taking the editor down.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { click, exists, openPanel, reveal } from './ui.mjs';

const PORT = 3170;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

mkdirSync('/tmp/mm-fixtures', { recursive: true });
const pts = Array.from({ length: 250 }, (_, i) => {
  const t = i / 249;
  return [100.5 + t * -1.5 + Math.sin(t * 20) * 0.05, 13.75 + t * 5 + Math.cos(t * 16) * 0.04];
});
writeFileSync(
  '/tmp/mm-fixtures/lib-ride.gpx',
  `<?xml version="1.0"?><gpx version="1.1"><trk><name>Library Ride</name><trkseg>
${pts.map(([lng, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`).join('\n')}
</trkseg></trk></gpx>`,
);

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

// The stop list lives in the Trip panel and the library in Output, so a
// count taken right after opening the library would see a closed panel.
const stopCount = async () => {
  await reveal(page, 'stop-list');
  return page.locator('[data-testid="stop-list"] li').count();
};
const routePoints = () =>
  page.evaluate(() => {
    const map = window.__map;
    const ids = Object.keys(map?.getStyle()?.sources ?? {});
    const id = ids.find((s) => s.startsWith('route-'));
    const src = id && map.getSource(id);
    const d = src?.serialize?.().data ?? src?._data;
    return d?.geometry?.coordinates?.length ?? -1;
  });
/** Toggling blindly can close an already-open panel; ensure the state. */
const openLibrary = async () => {
  await openPanel(page, 'output');
  if ((await page.locator('[data-testid="project-list"]').count()) === 0) {
    await click(page, 'toggle-library');
    await page.waitForTimeout(500);
  }
};
const closeLibrary = async () => {
  await openPanel(page, 'output');
  if ((await page.locator('[data-testid="project-list"]').count()) > 0) {
    await click(page, 'toggle-library');
    await page.waitForTimeout(300);
  }
};
const seekEnd = async () => {
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('input[type=range]')].pop();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(r, r.max);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
};

/**
 * Seek to the end and read the drawn point count, retrying because a state
 * change (title edit, geometry arriving) recompiles the project and resets
 * the playhead to 0 — a single read can land in that window and see nothing.
 */
const drawnPoints = async () => {
  for (let i = 0; i < 8; i++) {
    await seekEnd();
    const n = await routePoints();
    if (n > 2) return n;
    await page.waitForTimeout(500);
  }
  return await routePoints();
};

console.log('\n[library] save / load round-trip');
await page.goto(`http://localhost:${PORT}/?style=minimal`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

// Import a track, title it, save it.
await (await reveal(page, 'track-file-input')).setInputFiles('/tmp/mm-fixtures/lib-ride.gpx');
await page.waitForTimeout(2500);
await (await reveal(page, 'title-input')).fill('Saved Ride');
await page.waitForTimeout(1200);
const importedPoints = await drawnPoints();

await click(page, 'save-project');
await page.waitForTimeout(800);
await openLibrary();
const listed = await page.locator('[data-testid="project-item"]').count();
listed === 1 ? pass('saved project appears in the library') : fail('saved project appears in the library', listed);

// Wipe the editor by loading a template, then load the saved project back.
await closeLibrary();
await click(page, 'template-city-hops');
await page.waitForTimeout(2500);
(await stopCount()) === 5 ? pass('template replaced the trip') : fail('template replaced the trip', await stopCount());

await openLibrary();
await page.locator('[data-testid="project-item"] button').first().click();
await page.waitForTimeout(2500);

(await stopCount()) === 2 ? pass('loading restores the saved stops') : fail('loading restores the saved stops', await stopCount());
(await (await reveal(page, 'title-input')).inputValue()) === 'Saved Ride'
  ? pass('loading restores the title')
  : fail('loading restores the title');
const mode = await (await reveal(page, 'leg-0')).getAttribute('data-mode');
mode === 'file' ? pass('loading restores track mode') : fail('loading restores track mode', mode);

const restoredPoints = await drawnPoints();
restoredPoints === importedPoints && restoredPoints > 2
  ? pass(`imported track geometry survives save/load (${restoredPoints} pts — URLs cannot carry this)`)
  : fail('imported track geometry survives save/load', `${restoredPoints} vs ${importedPoints}`);

console.log('\n[library] persistence across a reload');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(3500);
await openLibrary();
(await page.locator('[data-testid="project-item"]').count()) >= 1
  ? pass('library survives a page reload')
  : fail('library survives a page reload');

console.log('\n[library] corrupt storage');
await page.evaluate(() => {
  localStorage.setItem(
    'mapmotion.projects.v1',
    JSON.stringify([
      { id: 'bad1' },
      { id: 'bad2', name: 'x', updatedAt: 1, stops: 'not-an-array' },
      { id: 'bad3', name: 'y', updatedAt: 2, stops: [{ name: 'a', coordinate: ['x', 'y'] }] },
      'totally-not-an-object',
    ]),
  );
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(3500);
pageErrors.length === 0 ? pass('corrupt entries do not throw on boot') : fail('corrupt entries do not throw on boot', pageErrors.join('; '));
await openLibrary();
(await page.locator('[data-testid="project-item"]').count()) === 0 &&
(await page.locator('[data-testid="project-empty"]').count()) === 1
  ? pass('corrupt entries are filtered out, empty state shown')
  : fail('corrupt entries are filtered out', await page.locator('[data-testid="project-item"]').count());
const stillWorks = !(await page.getByRole('button', { name: /Play|Pause/ }).isDisabled());
stillWorks ? pass('editor still usable with corrupt storage') : fail('editor still usable with corrupt storage');

// Garbage JSON entirely.
await page.evaluate(() => localStorage.setItem('mapmotion.projects.v1', '{{{not json'));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(3000);
pageErrors.length === 0 ? pass('unparseable storage does not throw') : fail('unparseable storage does not throw', pageErrors.join('; '));

console.log('\n[library] delete');
await page.evaluate(() => localStorage.removeItem('mapmotion.projects.v1'));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(3500);
await click(page, 'save-project');
await page.waitForTimeout(600);
await openLibrary();
const before = await page.locator('[data-testid="project-item"]').count();
await page.locator('[data-testid="project-item"] button[aria-label^="Delete"]').first().click();
await page.waitForTimeout(600);
const after = await page.locator('[data-testid="project-item"]').count();
after < before ? pass('delete removes a project') : fail('delete removes a project', `${before} -> ${after}`);

await page.screenshot({ path: '/tmp/library.png' });
await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Project library works' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
