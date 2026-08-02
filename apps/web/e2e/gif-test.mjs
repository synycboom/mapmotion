// Headful test of GIF export. The point is that a real, decodable, animated
// GIF comes out — verified with ffprobe, not by trusting the file extension.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { click, exists, reveal } from './ui.mjs';
import { rawStats } from './imgstats.mjs';

const PORT = 3230;
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
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--window-size=1400,950'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Small + fast so the software-GL render stays inside the budget.
await page.goto(
  `http://localhost:${PORT}/?s=Bangkok,100.5018,13.7563~Tokyo,139.6917,35.6895&style=minimal&spd=2.5&res=0.4`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(4000);

console.log('\n[gif] format toggle');
(await (await reveal(page, 'export-format-gif')).count()) === 1
  ? pass('GIF format option is offered')
  : fail('GIF format option is offered');

await click(page, 'export-format-gif');
await page.waitForTimeout(500);
(await (await reveal(page, 'export-button')).innerText()).includes('GIF')
  ? pass('export button reflects the chosen format')
  : fail('export button reflects the chosen format', await (await reveal(page, 'export-button')).innerText());

console.log('\n[gif] export');
const href = await page.evaluate(async () => {
  const b = document.querySelector('[data-testid="export-button"]');
  if (!b || b.disabled) return null;
  b.click();
  for (let i = 0; i < 300; i++) {
    const a = document.querySelector('a[download]');
    if (a) return a.getAttribute('href');
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
});

if (!href) {
  fail('GIF export completes', 'timed out');
} else {
  const b64 = await page.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  const out = '/tmp/export.gif';
  writeFileSync(out, Buffer.from(b64, 'base64'));
  pass('GIF export completes');

  const dl = await page.locator('a[download]').getAttribute('download');
  dl?.endsWith('.gif')
    ? pass('download is named .gif')
    : fail('download is named .gif', dl);

  // Real GIF? ffprobe, not the extension.
  let probe = null;
  try {
    probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,nb_frames',
        '-of', 'json', out,
      ]).toString(),
    ).streams?.[0];
  } catch (e) {
    probe = null;
  }
  probe?.codec_name === 'gif'
    ? pass(`decodes as a real GIF (${probe.width}x${probe.height})`)
    : fail('decodes as a real GIF', JSON.stringify(probe));

  const frames = Number(probe?.nb_frames ?? 0);
  frames > 5
    ? pass(`is animated (${frames} frames)`)
    : fail('is animated', frames);

  const stats = rawStats(out, { frameSelect: 1 });
  stats.distinctColors > 20
    ? pass(`frames are not blank (${stats.distinctColors} colours)`)
    : fail('frames are not blank', stats.distinctColors);

  const bytes = statSync(out).size;
  console.log(`  size ${(bytes / 1024).toFixed(0)} KB`);
  bytes > 5000 ? pass('file has real content') : fail('file has real content', bytes);
}

// Switching back to video must still work.
console.log('\n[gif] switching back to video');
await click(page, 'export-format-video');
await page.waitForTimeout(400);
(await (await reveal(page, 'export-button')).innerText()).includes('video')
  ? pass('can switch back to video export')
  : fail('can switch back to video export');

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ GIF export works' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
