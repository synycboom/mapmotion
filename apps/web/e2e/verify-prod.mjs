// Verify the production deployment: load the page, screenshot it, and run
// the autotest export against the live site.
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';

const URL_BASE = process.argv[2] ?? 'https://mapmotion-web.vercel.app';
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

console.log(`Loading ${URL_BASE} …`);
await page.goto(URL_BASE, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(4000); // let the map settle
await page.screenshot({ path: '/tmp/mapmotion-prod.png' });
console.log('Screenshot saved. Page errors:', errors.length ? errors : 'none');

console.log('Running export autotest against production…');
await page.goto(`${URL_BASE}/?autotest=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__exportResult !== undefined, null, {
  timeout: 300_000,
  polling: 1000,
});
const result = await page.evaluate(() => window.__exportResult);
console.log('Export result:', JSON.stringify(result, null, 2));
const b64 = await page.evaluate(() => window.__exportB64);
if (result.ok) {
  writeFileSync(`/tmp/mapmotion-prod.${result.ext}`, Buffer.from(b64, 'base64'));
  console.log(`Saved /tmp/mapmotion-prod.${result.ext}`);
}
await browser.close();
process.exit(result.ok ? 0 : 1);
