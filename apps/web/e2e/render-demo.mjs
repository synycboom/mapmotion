// Render the full-length 1280x720 demo video headlessly and save it.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3112;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
process.on('exit', () => {
  // Kill the process GROUP: npx forks a next-server that would otherwise
  // outlive us and hold the port.
  try { process.kill(-server.pid, 'SIGKILL'); } catch { try { server.kill('SIGKILL'); } catch {} }
});

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await sleep(500);
}

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
console.log('Rendering HD demo (this takes a few minutes headless)…');
await page.goto(`http://localhost:${PORT}/?autotest=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__exportResult !== undefined, null, {
  timeout: 900_000,
  polling: 2000,
});
const result = await page.evaluate(() => window.__exportResult);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
const b64 = await page.evaluate(() => window.__exportB64);
const out = `/tmp/mapmotion-demo.${result.ext}`;
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`Wrote ${out}`);
await browser.close();
process.exit(0);
