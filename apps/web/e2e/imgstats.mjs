// Dependency-free image/video frame statistics via ffmpeg -> raw rgb24.
// Used to prove a render isn't blank: a flat frame has ~0 variance and 1
// distinct colour; a real map has many.
import { execFileSync } from 'node:child_process';

/** Duration in seconds, or null if ffprobe can't tell. */
export function durationOf(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]).toString().trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function rawStats(file, { frameSelect = null, w = 160, h = 90 } = {}) {
  const args = ['-v', 'error'];
  if (frameSelect !== null) args.push('-ss', String(frameSelect));
  args.push(
    '-i', file,
    '-frames:v', '1',
    '-vf', `scale=${w}:${h}`,
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1',
  );
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });

  const seen = new Map();
  let sum = 0;
  let sumSq = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    const key = `${buf[i]},${buf[i + 1]},${buf[i + 2]}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const lum = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const top = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c, k]) => ({ rgb: c, pct: Math.round((k / n) * 100) }));

  return {
    distinctColors: seen.size,
    meanLuma: Math.round(mean * 10) / 10,
    stddev: Math.round(stddev * 10) / 10,
    top,
  };
}
