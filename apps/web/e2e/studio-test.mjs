// Headful test of Studio mode.
//
// The property that matters: Studio edits the SAME project Quick mode built —
// switching modes must never rebuild or lose work, and a retimed segment must
// change the real video duration, not just a label.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { click, exists, reveal } from './ui.mjs';

const PORT = 3190;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

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
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1500,1000'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const totalDuration = async () => {
  const t = await page.locator('text=/[\\d.]+s \\/ [\\d.]+s/').first().innerText();
  return Number(t.split('/')[1].trim().replace('s', ''));
};
const setRange = async (testid, value) => {
  await page.evaluate(
    ([id, v]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [testid, value],
  );
  await page.waitForTimeout(1200);
};

console.log('\n[studio] mode switch');
await page.goto(`http://localhost:${PORT}/?style=minimal`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

(await (await reveal(page, 'timeline')).count()) === 0
  ? pass('timeline hidden in Quick mode')
  : fail('timeline hidden in Quick mode');

const beforeSwitch = await totalDuration();
await click(page, 'mode-studio');
await page.waitForTimeout(1500);
(await (await reveal(page, 'timeline')).count()) === 1
  ? pass('timeline appears in Studio mode')
  : fail('timeline appears in Studio mode');
const afterSwitch = await totalDuration();
afterSwitch === beforeSwitch
  ? pass('switching modes does not change the project')
  : fail('switching modes does not change the project', `${beforeSwitch} -> ${afterSwitch}`);

// Default trip is 3 stops -> 2 legs, 3 dwell blocks.
(await (await reveal(page, 'tl-leg-0')).count()) === 1 &&
(await (await reveal(page, 'tl-leg-1')).count()) === 1
  ? pass('legs are drawn on the timeline')
  : fail('legs are drawn on the timeline');
(await (await reveal(page, 'tl-stop-0')).count()) === 1
  ? pass('stop dwells are drawn on the timeline')
  : fail('stop dwells are drawn on the timeline');

console.log('\n[studio] retiming');
await click(page, 'tl-leg-0');
await page.waitForTimeout(600);
(await (await reveal(page, 'segment-editor')).count()) === 1
  ? pass('clicking a leg opens the segment editor')
  : fail('clicking a leg opens the segment editor');
(await (await reveal(page, 'tl-leg-0')).getAttribute('data-active')) === '1'
  ? pass('selected block is highlighted')
  : fail('selected block is highlighted');

const durBefore = await totalDuration();
await setRange('segment-duration', 9000);
const durAfter = await totalDuration();
durAfter > durBefore
  ? pass(`retiming a leg changes the real duration (${durBefore}s -> ${durAfter}s)`)
  : fail('retiming a leg changes the real duration', `${durBefore} -> ${durAfter}`);

const label = await (await reveal(page, 'segment-duration-label')).innerText();
label.startsWith('9.0')
  ? pass('segment label reflects the new duration')
  : fail('segment label reflects the new duration', label);

// A retimed segment is marked as overridden and can be reverted.
(await (await reveal(page, 'clear-override')).count()) === 1
  ? pass('overridden segment offers an "auto" reset')
  : fail('overridden segment offers an "auto" reset');
await click(page, 'clear-override');
await page.waitForTimeout(1200);
const durReverted = await totalDuration();
Math.abs(durReverted - durBefore) < 0.15
  ? pass('reverting restores the derived duration')
  : fail('reverting restores the derived duration', `${durReverted} vs ${durBefore}`);

console.log('\n[studio] stop dwell + reset');
await click(page, 'tl-stop-1');
await page.waitForTimeout(600);
const dwellBefore = await totalDuration();
await setRange('segment-duration', 6000);
(await totalDuration()) > dwellBefore
  ? pass('retiming a stop dwell changes the duration')
  : fail('retiming a stop dwell changes the duration');

await click(page, 'reset-timing');
await page.waitForTimeout(1200);
Math.abs((await totalDuration()) - beforeSwitch) < 0.15
  ? pass('reset timing restores every derived duration')
  : fail('reset timing restores every derived duration', `${await totalDuration()} vs ${beforeSwitch}`);

console.log('\n[studio] playhead');
// y=60 is below both block rows (stops 4-28, legs 32-56) so the click
// reaches the track itself rather than selecting a segment.
await page.locator('[data-testid="timeline-track"]').click({ position: { x: 300, y: 60 } });
await page.waitForTimeout(800);
const head = await (await reveal(page, 'playhead')).getAttribute('style');
const leftPct = Number(head.match(/left:\s*([\d.]+)%/)?.[1] ?? 0);
leftPct > 5 && leftPct < 95
  ? pass(`clicking the track scrubs the playhead (${leftPct.toFixed(0)}%)`)
  : fail('clicking the track scrubs the playhead', leftPct);

console.log('\n[studio] survives edits');
await click(page, 'mode-quick');
await page.waitForTimeout(600);
await (await reveal(page, 'place-search')).fill('osaka');
await page.waitForSelector('[data-testid="place-results"] li', { timeout: 10_000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
await click(page, 'mode-studio');
await page.waitForTimeout(1500);
(await (await reveal(page, 'tl-leg-2')).count()) === 1
  ? pass('adding a stop adds a leg to the timeline')
  : fail('adding a stop adds a leg to the timeline');

await page.screenshot({ path: '/tmp/studio.png' });
pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Studio mode works' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
