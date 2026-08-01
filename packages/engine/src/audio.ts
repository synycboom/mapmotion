/**
 * Audio track and beat detection.
 *
 * No product in the animated-map category has audio at all, and the audience
 * is short-form video creators for whom the music *is* the edit. Cutting a
 * camera move on a beat is the single cheapest way to make a clip look
 * deliberate rather than generated.
 *
 * Everything here is pure and DOM-free, so beat detection is unit-testable
 * against synthetic click tracks in Node — which matters, because "does this
 * find the beat" is otherwise a question you can only answer by listening.
 */

/** Audio attached to a project. Samples live in the browser, not here. */
export interface AudioTrack {
  /** File name, for display only. */
  name: string;
  /** Length of the source audio. */
  durationMs: number;
  /** Where in the source the video starts. Lets you skip a long intro. */
  offsetMs: number;
  /** Linear gain, 0–1. */
  gain: number;
  /** Detected beat positions in ms from the start of the SOURCE audio. */
  beats: number[];
  /** Estimated tempo, or null when the signal has no discernible pulse. */
  bpm: number | null;
  /**
   * Beat period in ms, straight from the tempo estimator.
   *
   * NOT the median gap between `beats`: those are snapped to analysis frames
   * (~23ms at the default hop), so their median is quantised too. At 120 BPM
   * that reads as 511ms instead of 500 — under 3% off, but enough to drift by
   * more than half a beat across a 30-second video. The estimator's own
   * sub-frame figure is the one to time against.
   */
  periodMs: number | null;
  /** Fade the last stretch of the video out. */
  fadeOutMs: number;
}

export const DEFAULT_AUDIO: Omit<
  AudioTrack,
  'name' | 'durationMs' | 'beats' | 'bpm' | 'periodMs'
> = {
  offsetMs: 0,
  gain: 0.8,
  fadeOutMs: 800,
};

export interface BeatAnalysis {
  /** Beat times in ms from the start of the audio. */
  beats: number[];
  bpm: number | null;
  /** Sub-frame beat period in ms — see AudioTrack.periodMs. */
  periodMs: number | null;
  /**
   * How pulsed the material actually is, 0–1.
   *
   * Beat trackers always return an answer. Run one on room tone, a drone or
   * a voice memo and it will hand back a confident tempo built from
   * frame-boundary noise — and the user will snap their edit to nonsense
   * without ever being told the grid was invented. Below `MIN_SALIENCE` we
   * return no beats at all; above it, this number lets the UI say how much
   * to trust them.
   */
  confidence: number;
  /**
   * Onset-strength envelope, for drawing. One value per frame; frame i covers
   * `i * 1000 / envelopeHz` ms.
   */
  envelope: Float32Array;
  envelopeHz: number;
}

export interface BeatOptions {
  /** Analysis hop size in samples. Smaller is finer and slower. */
  hop?: number;
  /** Tempo search range. */
  minBpm?: number;
  maxBpm?: number;
  /** Tempo the prior favours when the evidence is ambiguous. */
  preferredBpm?: number;
  /**
   * How strongly beats are held to a regular grid. Higher means a steadier
   * pulse that ignores syncopation; lower follows the onsets more closely.
   */
  tightness?: number;
}

const EPS = 1e-10;

/**
 * Beat tracking, after Ellis (2007) "Beat Tracking by Dynamic Programming",
 * simplified to a full-band onset envelope.
 *
 * Three stages: build an onset-strength envelope, estimate one global tempo
 * from its autocorrelation, then choose the beat sequence that best trades
 * off landing on onsets against staying on the grid. The global-tempo
 * assumption is wrong for music that changes tempo, and right for essentially
 * everything anyone scores a 15-second map video with.
 */
export function analyseBeats(
  samples: Float32Array | number[],
  sampleRate: number,
  opts: BeatOptions = {},
): BeatAnalysis {
  const hop = Math.max(64, Math.round(opts.hop ?? 512));
  const envelopeHz = sampleRate / hop;
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const preferredBpm = opts.preferredBpm ?? 120;
  const tightness = opts.tightness ?? 90;

  const envelope = onsetEnvelope(samples, hop);
  const empty = { beats: [], bpm: null, periodMs: null, confidence: 0, envelope, envelopeHz };
  if (envelope.length < 8) return empty;

  const period = estimatePeriod(envelope, envelopeHz, minBpm, maxBpm, preferredBpm);
  if (period === null) return empty;

  const frames = trackBeats(envelope, period, tightness);
  if (frames.length === 0) return empty;

  const salience = beatSalience(envelope, frames);
  if (salience < MIN_SALIENCE) return empty;

  return {
    beats: frames.map((f) => (f / envelopeHz) * 1000),
    bpm: Math.round(((envelopeHz * 60) / period) * 10) / 10,
    periodMs: (period / envelopeHz) * 1000,
    confidence: clamp01((salience - MIN_SALIENCE / 2) / 16),
    envelope,
    envelopeHz,
  };
}

/**
 * Salience threshold, chosen from measurement rather than taste.
 *
 * Synthetic click tracks at 75–160 BPM, clean and noisy, score 15–30. A pure
 * tone scores 3.6 and broadband noise 3.8 — both cases where the tracker had
 * locked onto frame-boundary artefacts and reported a tempo anyway. 8 sits
 * well clear of both groups.
 */
const MIN_SALIENCE = 8;

/**
 * Mean onset strength at the chosen beats over mean onset strength overall.
 *
 * A real pulse puts its beats on the peaks, so the ratio is large; a grid
 * fitted to noise lands wherever the phase happened to fall, so it is near 1.
 * The +/-1 frame window is because a beat frame is an integer index and a
 * transient can straddle the boundary.
 */
function beatSalience(envelope: Float32Array, frames: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < envelope.length; i++) total += envelope[i]!;
  const meanAll = total / envelope.length;
  if (!(meanAll > 0)) return 0;

  let atBeats = 0;
  for (const f of frames) {
    let peak = 0;
    for (let d = -1; d <= 1; d++) {
      const j = f + d;
      if (j >= 0 && j < envelope.length && envelope[j]! > peak) peak = envelope[j]!;
    }
    atBeats += peak;
  }
  return atBeats / frames.length / meanAll;
}

/**
 * Half-wave-rectified log-energy difference per frame.
 *
 * Log rather than linear so a quiet passage's onsets count as much as a loud
 * one's — beat tracking on linear energy follows the mastering, not the drums.
 */
function onsetEnvelope(samples: Float32Array | number[], hop: number): Float32Array {
  const n = samples.length;
  const frames = Math.max(0, Math.floor(n / hop));
  if (frames < 2) return new Float32Array(0);

  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    const end = start + hop;
    for (let i = start; i < end; i++) {
      const v = samples[i] as number;
      sum += v * v;
    }
    energy[f] = Math.log(sum / hop + EPS);
  }

  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = energy[f]! - energy[f - 1]!;
    onset[f] = d > 0 ? d : 0;
  }

  // Subtract a local mean so a long crescendo doesn't read as a continuous
  // onset, then normalise to unit peak so `tightness` means the same thing
  // regardless of how the track was mastered.
  const smoothed = movingAverage(onset, Math.max(3, Math.round(frames / 200)));
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const v = onset[f]! - smoothed[f]!;
    onset[f] = v > 0 ? v : 0;
    if (onset[f]! > peak) peak = onset[f]!;
  }
  if (peak > 0) for (let f = 0; f < frames; f++) onset[f]! /= peak;
  return onset;
}

function movingAverage(x: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(x.length);
  let sum = 0;
  const w = radius * 2 + 1;
  for (let i = 0; i < x.length + radius; i++) {
    if (i < x.length) sum += x[i]!;
    if (i - w >= 0) sum -= x[i - w]!;
    const centre = i - radius;
    if (centre >= 0) out[centre] = sum / Math.min(w, x.length);
  }
  return out;
}

/**
 * Dominant inter-onset period in frames, via autocorrelation with a
 * log-Gaussian tempo prior.
 *
 * The prior is what stops the estimator settling on half or double the real
 * tempo, which autocorrelation does constantly — every multiple of the true
 * period is also a correlation peak, and without a preference between them
 * the choice is arbitrary.
 */
function estimatePeriod(
  envelope: Float32Array,
  envelopeHz: number,
  minBpm: number,
  maxBpm: number,
  preferredBpm: number,
): number | null {
  const minLag = Math.max(2, Math.floor((envelopeHz * 60) / maxBpm));
  const maxLag = Math.min(envelope.length - 1, Math.ceil((envelopeHz * 60) / minBpm));
  if (maxLag <= minLag) return null;

  const preferredLag = (envelopeHz * 60) / preferredBpm;
  let best = -Infinity;
  let bestLag = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < envelope.length; i++) sum += envelope[i]! * envelope[i - lag]!;
    const norm = sum / (envelope.length - lag);
    // Octave prior: penalty grows with the log-distance from the preferred
    // tempo, so 120 beats 60 and 240 on equal evidence but loses to a clear
    // 150.
    const dev = Math.log2(lag / preferredLag);
    const score = norm * Math.exp(-0.5 * (dev / 0.9) ** 2);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || best <= 0) return null;
  return refinePeriod(envelope, bestLag);
}

/** Parabolic interpolation around the winning lag, for sub-frame precision. */
function refinePeriod(envelope: Float32Array, lag: number): number {
  const at = (l: number) => {
    if (l < 1 || l >= envelope.length) return 0;
    let sum = 0;
    for (let i = l; i < envelope.length; i++) sum += envelope[i]! * envelope[i - l]!;
    return sum / (envelope.length - l);
  };
  const y0 = at(lag - 1);
  const y1 = at(lag);
  const y2 = at(lag + 1);
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < EPS) return lag;
  const shift = (0.5 * (y0 - y2)) / denom;
  return lag + Math.max(-0.5, Math.min(0.5, shift));
}

/**
 * Dynamic programming over beat positions.
 *
 * `score[i]` is the best total for a beat sequence ending at frame i. The
 * transition cost is a log-squared penalty on how far the gap from the
 * previous beat strays from the estimated period, so the sequence stays on
 * the grid through a bar with no onsets at all — which is exactly where a
 * naive peak-picker loses the beat.
 */
function trackBeats(envelope: Float32Array, period: number, tightness: number): number[] {
  const n = envelope.length;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);

  const searchStart = Math.max(1, Math.round(period / 2));
  const searchEnd = Math.max(searchStart + 1, Math.round(period * 2));

  for (let i = 0; i < n; i++) {
    let bestPrev = -Infinity;
    let bestJ = -1;
    for (let d = searchStart; d <= searchEnd; d++) {
      const j = i - d;
      if (j < 0) break;
      const dev = Math.log(d / period);
      const candidate = score[j]! - tightness * dev * dev;
      if (candidate > bestPrev) {
        bestPrev = candidate;
        bestJ = j;
      }
    }
    if (bestJ < 0) {
      score[i] = envelope[i]!;
    } else {
      score[i] = envelope[i]! + bestPrev;
      back[i] = bestJ;
    }
  }

  // Start the backtrace from the best position in the final period, so a
  // trailing silence can't drag the chain off the end.
  let tail = -1;
  let bestTail = -Infinity;
  const from = Math.max(0, n - Math.ceil(period) - 1);
  for (let i = from; i < n; i++) {
    if (score[i]! > bestTail) {
      bestTail = score[i]!;
      tail = i;
    }
  }
  if (tail < 0) return [];

  const out: number[] = [];
  for (let i = tail; i >= 0; i = back[i]!) {
    out.push(i);
    if (back[i] === -1) break;
  }
  out.reverse();
  // A "beat sequence" of one or two frames is noise, not a pulse.
  return out.length >= 3 ? out : [];
}

/**
 * Move each time to the nearest beat, but only if a beat is close enough.
 *
 * The limit matters: snapping a stop that sits 900ms from any beat would move
 * it somewhere the user did not ask for. Better to leave it alone and let the
 * ones that were nearly right become exactly right.
 */
export function snapTimesToBeats(
  times: readonly number[],
  beats: readonly number[],
  maxShiftMs = 250,
): number[] {
  if (beats.length === 0) return [...times];
  return times.map((t) => {
    const b = nearestBeat(beats, t);
    return b !== null && Math.abs(b - t) <= maxShiftMs ? b : t;
  });
}

/** Nearest beat to `tMs`, or null when there are none. Binary search. */
export function nearestBeat(beats: readonly number[], tMs: number): number | null {
  if (beats.length === 0) return null;
  let lo = 0;
  let hi = beats.length - 1;
  if (tMs <= beats[lo]!) return beats[lo]!;
  if (tMs >= beats[hi]!) return beats[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! <= tMs) lo = mid;
    else hi = mid;
  }
  return tMs - beats[lo]! <= beats[hi]! - tMs ? beats[lo]! : beats[hi]!;
}

/** Beats falling inside a window, as ms offsets from `startMs`. */
export function beatsInWindow(
  beats: readonly number[],
  startMs: number,
  endMs: number,
): number[] {
  return beats.filter((b) => b >= startMs && b <= endMs).map((b) => b - startMs);
}

/**
 * Playback gain at a moment of the VIDEO timeline, including the fade-out.
 * Returns 0 outside the video, so an export can't leak audio past the end.
 */
export function audioGainAt(
  track: AudioTrack,
  tMs: number,
  videoDurationMs: number,
): number {
  if (tMs < 0 || tMs > videoDurationMs) return 0;
  const base = clamp01(track.gain);
  const fade = Math.max(0, track.fadeOutMs);
  if (fade <= 0) return base;
  const remaining = videoDurationMs - tMs;
  if (remaining >= fade) return base;
  return base * clamp01(remaining / fade);
}

/**
 * Where in the source audio the video is at `tMs`, or null once the source
 * has run out — a 10-second song under a 30-second video goes silent rather
 * than looping, because looping is a decision the user should make.
 */
export function sourceTimeAt(track: AudioTrack, tMs: number): number | null {
  const src = track.offsetMs + tMs;
  return src >= 0 && src <= track.durationMs ? src : null;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Median interval between beats, in ms.
 *
 * Median rather than mean because a beat tracker occasionally drops or
 * doubles one, and a single dropped beat pulls the mean far enough to make
 * every quantised duration wrong.
 */
export function beatPeriodMs(beats: readonly number[]): number | null {
  if (beats.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i]! - beats[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const period =
    gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  return period > 0 ? period : null;
}

export interface QuantiseOptions {
  /** Never shorter than this many beats. */
  minBeats?: number;
  /** Never longer than this many beats. */
  maxBeats?: number;
  /**
   * Beats per unit — 0.5 allows half-beat segments, 2 forces even numbers.
   * Half-beats are the default because a 1.4s dwell against a 120 BPM track
   * is three half-beats, and forcing it to two whole ones changes the edit
   * more than it improves it.
   */
  grid?: number;
}

/**
 * Round each segment to a whole number of beats.
 *
 * This is what "snap to the beat" should mean for a sequence: not nudging
 * each boundary to the nearest beat — which accumulates drift and can reorder
 * two close boundaries — but making every segment an exact multiple of the
 * beat period. Do that and every boundary lands on the grid by construction,
 * the relative pacing the user chose is preserved, and the result stays
 * locked to the music for the whole video however long it runs.
 */
export function quantiseDurations(
  durations: readonly number[],
  periodMs: number,
  opts: QuantiseOptions = {},
): number[] {
  if (!(periodMs > 0)) return [...durations];
  const grid = opts.grid && opts.grid > 0 ? opts.grid : 0.5;
  const unit = periodMs * grid;
  const minUnits = Math.max(1, Math.round((opts.minBeats ?? grid) / grid));
  const maxUnits = opts.maxBeats ? Math.max(minUnits, Math.round(opts.maxBeats / grid)) : Infinity;

  return durations.map((d) => {
    if (!Number.isFinite(d) || d <= 0) return Math.round(unit * minUnits);
    const units = Math.min(maxUnits, Math.max(minUnits, Math.round(d / unit)));
    return Math.round(units * unit);
  });
}

/**
 * Shift the audio so the first beat lands at a given point in the video.
 *
 * Quantising the segments locks the *rhythm* to the track but says nothing
 * about the *phase*: the video still starts wherever the file starts, which
 * is usually a fraction of a beat off. Trimming the audio to begin on a beat
 * is what makes the first cut land.
 */
export function offsetToFirstBeat(beats: readonly number[], skipBeats = 0): number {
  if (beats.length === 0) return 0;
  const i = Math.min(beats.length - 1, Math.max(0, Math.round(skipBeats)));
  return Math.max(0, beats[i]!);
}
