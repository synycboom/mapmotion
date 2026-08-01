// Headful test of the soundtrack: import, beat detection, snap-to-beat, and
// audio actually surviving into the exported file.
//
// The export assertion is the one that matters. "The UI says audio is
// included" is worth nothing — ffprobe has to find an audio stream in the
// file, and it has to contain the beats we put there.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockTileServer } from './mock-tileserver.mjs';

const APP_PORT = 3300;
const TILE_PORT = 3301;
const exe = [
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find((p) => existsSync(p));

const checks = {};
const pass = (k) => { checks[k] = true; console.log(`  ✓ ${k}`); };
const fail = (k, d) => { checks[k] = false; console.log(`  ✗ ${k}${d ? `: ${d}` : ''}`); };

// ---------------------------------------------------------------------------
// A 120 BPM click track as a real WAV file, built with ffmpeg so the browser
// is decoding an actual container rather than something we hand-rolled.
// ---------------------------------------------------------------------------
const BPM = 120;
const AUDIO_SECONDS = 20;
const WAV = '/tmp/mm-click.wav';
mkdirSync('/tmp', { recursive: true });

function buildClickTrack() {
  const sr = 44100;
  const n = sr * AUDIO_SECONDS;
  const periodSamples = Math.round((60 / BPM) * sr);
  const decay = Math.round(sr * 0.05);
  const pcm = Buffer.alloc(n * 2);

  for (let i = 0; i < n; i++) {
    // Quiet non-repeating bed, so the detector isn't tuned on pure silence.
    let v = 0.02 * (Math.sin(i * 0.0193) * 0.6 + Math.sin(i * 0.0071 + 1.1) * 0.4);
    const phase = i % periodSamples;
    if (phase < decay) v += Math.exp(-phase / (decay * 0.25)) * Math.sin(phase * 0.9) * 0.85;
    const clamped = Math.max(-1, Math.min(1, v));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(WAV, Buffer.concat([header, pcm]));
}
buildClickTrack();

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
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--window-size=1500,1000',
    // No speakers in a container; this gives WebAudio something to run on.
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(
  `http://localhost:${APP_PORT}/?s=Paris,2.3522,48.8566~Lyon,4.8357,45.7640&styleUrl=${encodeURIComponent(styleUrl)}&res=0.3&spd=2.5`,
  { waitUntil: 'load' },
);
await page.waitForTimeout(5000);

console.log('\n[audio] import + detection');
(await page.locator('[data-testid="audio-panel"]').count()) === 1
  ? pass('audio panel renders')
  : fail('audio panel renders');

await page.locator('[data-testid="audio-input"]').setInputFiles(WAV);
// Decoding plus analysis of 20s of audio; give it room on software GL.
await page.waitForTimeout(6000);

(await page.locator('[data-testid="audio-name"]').count()) === 1
  ? pass('the file is accepted')
  : fail('the file is accepted', await page.locator('[data-testid="audio-error"]').innerText().catch(() => ''));

const tempoText = await page.locator('[data-testid="audio-tempo"]').innerText().catch(() => '');
const detectedBpm = Number(tempoText.match(/([\d.]+)\s*BPM/)?.[1] ?? NaN);
Math.abs(detectedBpm - BPM) < 3
  ? pass(`detects the true tempo in a real file (${detectedBpm} BPM)`)
  : fail('detects the true tempo in a real file', tempoText);

const beatCount = await page.evaluate(() => window.__mmProject?.audio?.beats?.length ?? 0);
beatCount > 30
  ? pass(`beats reach the compiled project (${beatCount} over ${AUDIO_SECONDS}s)`)
  : fail('beats reach the compiled project', beatCount);

(await page.locator('[data-testid="audio-waveform"]').count()) === 1
  ? pass('the waveform renders')
  : fail('the waveform renders');

console.log('\n[audio] cut to the beat');
await page.locator('[data-testid="audio-snap"]').click();
await page.waitForTimeout(2500);

// Every segment must now be a whole number of half-beats, so every boundary
// lands on the grid. Read the compiled keyframes, not the UI — and grid
// against the period the app actually used, since a detector that is 1% off
// on a real file is correct behaviour, not a bug.
const grid = await page.evaluate(() => {
  const project = window.__mmProject;
  const period = project?.audio?.periodMs;
  const kfs = project?.camera ?? [];
  if (!period) return { count: 0, period: null, offGrid: ['no period'] };
  const halfBeat = period / 2;
  const offGrid = [];
  for (const k of kfs) {
    const units = k.tMs / halfBeat;
    // One millisecond of rounding per boundary is the compiler's, not drift.
    if (Math.abs(units - Math.round(units)) * halfBeat > 2) offGrid.push(Math.round(k.tMs));
  }
  return { count: kfs.length, period, offGrid };
});

grid.count > 0 && grid.offGrid.length === 0
  ? pass(`every camera keyframe lands on the beat grid (${grid.count} keyframes, ${Math.round(grid.period)}ms period)`)
  : fail('every camera keyframe lands on the beat grid', JSON.stringify(grid).slice(0, 160));

// And the period the app timed against must be the accurate one, not the
// frame-quantised median of the beat list.
Math.abs(grid.period - (60 / BPM) * 1000) < 12
  ? pass(`the timing period is accurate (${grid.period.toFixed(1)}ms vs ${(60 / BPM) * 1000}ms true)`)
  : fail('the timing period is accurate', grid.period);

// Snapping should move to Studio mode so the result is visible and editable
// rather than a hidden change to the timing.
(await page.locator('[data-testid="mode-studio"]').getAttribute('style'))?.includes('232, 89, 12') ||
(await page.locator('[data-testid="timeline"]').count()) > 0
  ? pass('snapping reveals the retimed timeline')
  : fail('snapping reveals the retimed timeline');

console.log('\n[audio] export');
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
  fail('export completes', 'timed out');
} else {
  const b64 = await page.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  const ext = (await page.locator('a[download]').getAttribute('download'))?.split('.').pop() ?? 'bin';
  const out = `/tmp/mm-audio-export.${ext}`;
  writeFileSync(out, Buffer.from(b64, 'base64'));
  pass('export completes');

  const streams = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate,duration',
      '-of', 'json', out,
    ]).toString(),
  ).streams ?? [];

  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const videoStream = streams.find((s) => s.codec_type === 'video');

  videoStream ? pass('the file has a video stream') : fail('the file has a video stream');

  const reported = await page.evaluate(() => window.__exportResult?.audio ?? null);
  if (audioStream) {
    pass(`the file has a real audio stream (${audioStream.codec_name}, ${audioStream.channels}ch @ ${audioStream.sample_rate}Hz)`);
    reported === 'included'
      ? pass('the UI agrees audio was included')
      : fail('the UI agrees audio was included', String(reported));

    // Decode the audio back and check the beat is still in it — a muxed but
    // silent or garbled track would pass every check above.
    const raw = execFileSync('ffmpeg', [
      '-v', 'error', '-i', out,
      '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1',
    ], { maxBuffer: 256 * 1024 * 1024 });
    const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
      energy += v;
    }
    const mean = samples.length ? energy / samples.length : 0;
    peak > 0.05
      ? pass(`the exported audio is not silent (peak ${peak.toFixed(3)}, mean ${mean.toFixed(4)})`)
      : fail('the exported audio is not silent', `peak ${peak}`);

    // The click track is periodic at 2 Hz. Autocorrelating the decoded
    // envelope at that lag should stand out clearly if the beat survived.
    const lag = Math.round(8000 * (60 / BPM));
    let atBeat = 0;
    let offBeat = 0;
    const half = Math.round(lag / 2);
    for (let i = lag; i < samples.length; i++) {
      atBeat += Math.abs(samples[i]) * Math.abs(samples[i - lag]);
      offBeat += Math.abs(samples[i]) * Math.abs(samples[i - half]);
    }
    atBeat > offBeat
      ? pass('the pulse survives encoding (beat-lag correlation beats off-beat)')
      : fail('the pulse survives encoding', `${atBeat.toFixed(1)} vs ${offBeat.toFixed(1)}`);
  } else {
    // No AudioEncoder in this build of Chromium is an environment limit, not
    // a product fault — but the app must SAY so rather than quietly dropping
    // the music.
    console.log('  (no audio stream — checking the app reported why)');
    reported === 'unsupported-encoder' || reported === 'failed'
      ? pass(`no encoder here, and the app says so ("${reported}")`)
      : fail('no encoder here, and the app says so', `reported "${reported}"`);
    (await page.locator('[data-testid="audio-outcome"]').count()) === 1
      ? pass('the user is told the video is silent')
      : fail('the user is told the video is silent');
  }
}

console.log('\n[audio] removal');
await page.locator('[data-testid="audio-remove"]').click();
await page.waitForTimeout(800);
(await page.locator('[data-testid="audio-drop"]').count()) === 1
  ? pass('the soundtrack can be removed')
  : fail('the soundtrack can be removed');

console.log('\n[audio] rejecting rubbish');
writeFileSync('/tmp/mm-not-audio.wav', Buffer.from('this is definitely not audio data', 'utf8'));
await page.locator('[data-testid="audio-input"]').setInputFiles('/tmp/mm-not-audio.wav');
await page.waitForTimeout(3000);
(await page.locator('[data-testid="audio-error"]').count()) === 1
  ? pass('an undecodable file produces an error, not a crash')
  : fail('an undecodable file produces an error, not a crash');

pageErrors.length === 0 ? pass('no page errors') : fail('no page errors', pageErrors.slice(0, 2).join('; '));

await browser.close();
cleanup();

console.log('\n=== RESULT ===');
const total = Object.keys(checks).length;
const good = Object.values(checks).filter(Boolean).length;
console.log(`${good}/${total} checks passed`);
const ok = good === total;
console.log(ok ? '\n✅ Soundtrack and beat snapping work' : '\n❌ Failures');
process.exit(ok ? 0 : 1);
