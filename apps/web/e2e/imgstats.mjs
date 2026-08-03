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

export function rawStats(
  file,
  { frameSelect = null, w = 160, h = 90, crop = null } = {},
) {
  const args = ['-v', 'error'];
  if (frameSelect !== null) args.push('-ss', String(frameSelect));
  const filters = [];
  if (crop && crop.w > 1 && crop.h > 1) {
    const r = (n) => Math.max(0, Math.round(n));
    filters.push(`crop=${r(crop.w)}:${r(crop.h)}:${r(crop.x ?? 0)}:${r(crop.y ?? 0)}`);
  }
  filters.push(`scale=${w}:${h}`);
  args.push(
    '-i', file,
    '-frames:v', '1',
    '-vf', filters.join(','),
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

/**
 * Colour statistics for a rectangle of a PNG screenshot.
 *
 * Screenshots are in DEVICE pixels while `getBoundingClientRect()` is in CSS
 * pixels, so the rect has to be scaled by the device pixel ratio or the crop
 * lands somewhere else entirely — on a 3× iPhone profile it would sample the
 * top-left ninth of the intended region and quietly pass or fail for the
 * wrong reason.
 */
export function pngStats(file, rect = null, dpr = 1) {
  const crop = rect
    ? { x: rect.x * dpr, y: rect.y * dpr, w: rect.w * dpr, h: rect.h * dpr }
    : null;
  try {
    return rawStats(file, { crop });
  } catch (e) {
    // A collapsed or off-canvas rect makes ffmpeg's crop filter throw. That
    // IS the failure the caller is testing for, so report it as an empty
    // region rather than exploding and taking the whole suite with it.
    return { distinctColors: 0, meanLuma: 0, stddev: 0, top: [], error: String(e.message ?? e).slice(0, 120) };
  }
}

/**
 * Raw RGB pixels of a region, for questions colour statistics can't answer —
 * "is there a red circle in the middle of this map" being the one that
 * matters when the thing under test is whether a sprite drew at all.
 */
export function rawPixels(file, rect = null, dpr = 1, w = 240, h = 240) {
  const crop = rect
    ? { x: rect.x * dpr, y: rect.y * dpr, w: rect.w * dpr, h: rect.h * dpr }
    : null;
  const filters = [];
  if (crop && crop.w > 1 && crop.h > 1) {
    const r = (n) => Math.max(0, Math.round(n));
    filters.push(`crop=${r(crop.w)}:${r(crop.h)}:${r(crop.x)}:${r(crop.y)}`);
  }
  filters.push(`scale=${w}:${h}`);
  try {
    const buf = execFileSync('ffmpeg', [
      '-v', 'error', '-i', file, '-frames:v', '1',
      '-vf', filters.join(','), '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { maxBuffer: 64 * 1024 * 1024 });
    return { data: buf, width: w, height: h };
  } catch {
    return { data: Buffer.alloc(0), width: 0, height: 0 };
  }
}

/**
 * Per-frame statistics for EVERY frame of a video, in one ffmpeg pass.
 *
 * `rawStats` samples a single frame, which is enough to prove a render isn't
 * blank but says nothing about whether the render is *stable*. Tile pop-in is
 * invisible to any single-frame check by construction: the frame before and
 * the frame after both look perfect.
 *
 * Frames are decoded small (default 96×54) because the question is "what
 * fraction of this frame is basemap versus hole", and that answer does not
 * improve with resolution — it just costs 200× the bytes.
 */
export function frameSeries(file, { w = 96, h = 54, darkBelow = 70 } = {}) {
  const buf = execFileSync(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', file,
      '-vf', `scale=${w}:${h}`,
      '-pix_fmt', 'rgb24',
      '-f', 'rawvideo',
      'pipe:1',
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );

  const frameBytes = w * h * 3;
  const count = Math.floor(buf.length / frameBytes);
  const frames = [];
  for (let f = 0; f < count; f++) {
    const start = f * frameBytes;
    let dark = 0;
    let sum = 0;
    for (let i = start; i < start + frameBytes; i += 3) {
      const lum = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
      sum += lum;
      if (lum < darkBelow) dark++;
    }
    const n = w * h;
    frames.push({
      index: f,
      meanLuma: sum / n,
      // Fraction of the frame that is background rather than drawn basemap.
      // On a light basemap a hole where a tile has not arrived is dark; this
      // is the signal the whole suite turns on.
      darkFrac: dark / n,
      // Kept so consecutive frames can be compared pixel for pixel. Small
      // enough (96×54×3 = 15KB) that holding a whole video costs a few MB.
      bytes: buf.subarray(start, start + frameBytes),
    });
  }
  return frames;
}

/**
 * Mean absolute per-channel difference between each frame and the one before.
 *
 * The number that says whether the video is actually moving. Encoding is
 * lossy, so two renders of the same camera position do not come back
 * byte-identical — the measure has to be a distance, not equality.
 */
export function frameDiffs(frames) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].bytes;
    const b = frames[i].bytes;
    let sum = 0;
    for (let j = 0; j < a.length; j++) sum += Math.abs(a[j] - b[j]);
    out.push({ index: i, diff: sum / a.length });
  }
  return out;
}

/**
 * Frames indistinguishable from the one before them.
 *
 * The threshold is set to separate "frozen" from "moving slowly", and those
 * are much closer together than they look. On a healthy export of a trip with
 * an orbiting dwell, the quietest frame in the body measures about 0.03 while
 * the deliberately-held frames at the very end measure 0.000–0.018. There is
 * a real gap there, but it is a narrow one, and an earlier version of this
 * function used 0.35 — which swept up every arrival and departure and
 * reported a correct export as 28 stalled frames.
 *
 * So: 0.025, and the claim is only ever "this frame is a repeat", never "this
 * frame is slow". Slowing into a stop is the feature.
 */
export function stalledFrames(frames, threshold = 0.025) {
  return frameDiffs(frames)
    .filter((d) => d.diff < threshold)
    .map((d) => ({ index: d.index, diff: Math.round(d.diff * 10000) / 10000 }));
}

/**
 * Frames whose background fraction disagrees with BOTH neighbours.
 *
 * Compared against the mean of the two neighbours rather than against the
 * previous frame alone, because a fly-through legitimately changes how much
 * basemap is on screen — smoothly. A tile that arrives late produces a hole
 * in one frame that is absent from the frames either side of it, which is a
 * spike no camera move can generate at 30fps.
 *
 * Returns the offending frames with the size of the discrepancy, so a failure
 * message can say "frame 84 is 11% emptier than its neighbours" instead of
 * "expected true, got false".
 */
export function popInFrames(frames, tolerance = 0.03) {
  const bad = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const expected = (frames[i - 1].darkFrac + frames[i + 1].darkFrac) / 2;
    const delta = frames[i].darkFrac - expected;
    // One-sided: only EXTRA background is a fault. A frame with less
    // background than its neighbours means more map drew, never less.
    if (delta > tolerance) {
      bad.push({ index: i, delta: Math.round(delta * 1000) / 10, darkFrac: frames[i].darkFrac });
    }
  }
  return bad;
}

/** How many pixels satisfy `test(r, g, b)`. */
export function countPixels({ data }, test) {
  let n = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    if (test(data[i], data[i + 1], data[i + 2])) n++;
  }
  return n;
}
