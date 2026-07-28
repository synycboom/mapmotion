// Headless end-to-end proof: load the editor with ?autotest=1, let it render
// and encode a real video via WebCodecs, pull the bytes out, validate with
// ffprobe. This is the Phase 0 exit criterion running in CI conditions.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3111;
const CHROMIUM_CANDIDATES = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
];

const exe = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.error('No chromium found in /opt/pw-browsers');
  process.exit(1);
}

// Start the production server.
const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'pipe',
});
server.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`));

const kill = () => {
  try {
    server.kill('SIGTERM');
  } catch {}
};
process.on('exit', kill);

// Wait for the server.
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.ok) {
      up = true;
      break;
    }
  } catch {}
  await sleep(500);
}
if (!up) {
  console.error('Server did not start');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log(`[console.error] ${msg.text()}`);
});
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));

console.log('Loading autotest page…');
await page.goto(`http://localhost:${PORT}/?autotest=1`, { waitUntil: 'load' });

await page.waitForFunction(() => window.__exportResult !== undefined, null, {
  timeout: 300_000,
  polling: 1000,
});

const result = await page.evaluate(() => window.__exportResult);
console.log('Export result:', JSON.stringify(result, null, 2));

if (!result.ok) {
  console.error('EXPORT FAILED');
  await browser.close();
  process.exit(1);
}

const b64 = await page.evaluate(() => window.__exportB64);
const outfile = `/tmp/mapmotion-spike.${result.ext}`;
writeFileSync(outfile, Buffer.from(b64, 'base64'));
console.log(`Wrote ${outfile} (${result.bytes} bytes)`);

await browser.close();
kill();

// Validate with ffprobe.
const probe = execFileSync('ffprobe', [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name,width,height,nb_frames,avg_frame_rate,duration',
  '-of', 'json',
  outfile,
]).toString();
console.log('ffprobe:', probe);

const stream = JSON.parse(probe).streams?.[0];
if (!stream) {
  console.error('ffprobe found no video stream');
  process.exit(1);
}
const expected = { width: 640, height: 360 };
if (stream.width !== expected.width || stream.height !== expected.height) {
  console.error(`Resolution mismatch: got ${stream.width}x${stream.height}`);
  process.exit(1);
}

console.log('\n✅ PHASE 0 EXIT CRITERIA: headless export produced a valid video');
process.exit(0);
