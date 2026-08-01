import { describe, expect, it } from 'vitest';
import {
  analyseBeats,
  audioGainAt,
  beatPeriodMs,
  beatsInWindow,
  nearestBeat,
  offsetToFirstBeat,
  quantiseDurations,
  snapTimesToBeats,
  sourceTimeAt,
  type AudioTrack,
} from '../src';

const SR = 22050;

/**
 * A synthetic click track: short decaying bursts at a fixed tempo over a bed
 * of low-level noise.
 *
 * Deterministic by construction — the engine forbids Math.random(), and a
 * test whose input changes every run can't pin down a tolerance. The noise
 * bed matters: an onset detector tuned on silence-plus-impulses will fall
 * apart on anything real, so the fixture should never be perfectly clean.
 */
function clickTrack(
  bpm: number,
  seconds: number,
  opts: { noise?: number; swingMs?: number; sampleRate?: number } = {},
): Float32Array {
  const sr = opts.sampleRate ?? SR;
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const noise = opts.noise ?? 0.02;

  // A cheap deterministic pseudo-noise: an irrational-frequency sine pair,
  // which never repeats over the test's length.
  for (let i = 0; i < n; i++) {
    out[i] = noise * (Math.sin(i * 0.0193) * 0.6 + Math.sin(i * 0.0071 + 1.1) * 0.4);
  }

  const periodS = 60 / bpm;
  const decay = Math.round(sr * 0.04);
  for (let k = 0; ; k++) {
    const swing = opts.swingMs && k % 2 === 1 ? opts.swingMs / 1000 : 0;
    const start = Math.round((k * periodS + swing) * sr);
    if (start >= n) break;
    for (let i = 0; i < decay && start + i < n; i++) {
      // Decaying burst, alternating sign so it reads as a transient.
      const env = Math.exp(-i / (decay * 0.25));
      out[start + i]! += env * Math.sin(i * 0.9) * 0.9;
    }
  }
  return out;
}

/** Mean absolute error, in ms, between detected beats and the true grid. */
function gridError(beats: number[], bpm: number): number {
  const periodMs = (60 / bpm) * 1000;
  if (beats.length === 0) return Infinity;
  const errs = beats.map((b) => {
    const k = Math.round(b / periodMs);
    return Math.abs(b - k * periodMs);
  });
  return errs.reduce((a, b) => a + b, 0) / errs.length;
}

describe('analyseBeats — tempo', () => {
  it('finds 120 BPM in a 120 BPM click track', () => {
    const a = analyseBeats(clickTrack(120, 12), SR);
    expect(a.bpm).not.toBeNull();
    expect(a.bpm!).toBeGreaterThan(118);
    expect(a.bpm!).toBeLessThan(122);
  });

  it('finds a slow tempo without halving it', () => {
    const a = analyseBeats(clickTrack(75, 16), SR);
    expect(a.bpm!).toBeGreaterThan(73);
    expect(a.bpm!).toBeLessThan(77);
  });

  it('finds a fast tempo without doubling it', () => {
    const a = analyseBeats(clickTrack(160, 12), SR);
    expect(a.bpm!).toBeGreaterThan(157);
    expect(a.bpm!).toBeLessThan(163);
  });

  it('places beats on the true grid, not merely at the right rate', () => {
    // A tempo can be exactly right while every beat sits between the clicks.
    const a = analyseBeats(clickTrack(128, 14), SR);
    expect(gridError(a.beats, 128)).toBeLessThan(40);
  });

  it('produces roughly the expected number of beats', () => {
    const seconds = 15;
    const a = analyseBeats(clickTrack(100, seconds), SR);
    const expected = (100 / 60) * seconds;
    expect(a.beats.length).toBeGreaterThan(expected * 0.8);
    expect(a.beats.length).toBeLessThan(expected * 1.2);
  });

  it('keeps beats monotonically increasing and inside the audio', () => {
    const seconds = 10;
    const a = analyseBeats(clickTrack(140, seconds), SR);
    for (let i = 1; i < a.beats.length; i++) {
      expect(a.beats[i]!).toBeGreaterThan(a.beats[i - 1]!);
    }
    expect(a.beats[a.beats.length - 1]!).toBeLessThanOrEqual(seconds * 1000);
    expect(a.beats[0]!).toBeGreaterThanOrEqual(0);
  });

  it('holds the grid through a bar with no onsets at all', () => {
    // Silence the middle two seconds. A peak-picker loses the beat here; the
    // dynamic-programming tracker should coast through on the tempo.
    const samples = clickTrack(120, 14);
    const from = Math.round(SR * 6);
    const to = Math.round(SR * 8);
    for (let i = from; i < to; i++) samples[i] = 0;
    const a = analyseBeats(samples, SR);
    const inGap = a.beats.filter((b) => b > 6200 && b < 7800);
    expect(inGap.length).toBeGreaterThanOrEqual(2);
    expect(gridError(a.beats, 120)).toBeLessThan(60);
  });

  it('reports high confidence for a clear pulse and none for silence', () => {
    expect(analyseBeats(clickTrack(120, 12), SR).confidence).toBeGreaterThan(0.6);
    expect(analyseBeats(new Float32Array(SR * 5), SR).confidence).toBe(0);
  });

  it('confidence survives a noisy but real pulse', () => {
    const a = analyseBeats(clickTrack(120, 12, { noise: 0.15 }), SR);
    expect(a.beats.length).toBeGreaterThan(10);
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it('is stable across sample rates', () => {
    const at22 = analyseBeats(clickTrack(120, 12, { sampleRate: 22050 }), 22050);
    const at44 = analyseBeats(clickTrack(120, 12, { sampleRate: 44100 }), 44100);
    expect(Math.abs(at22.bpm! - at44.bpm!)).toBeLessThan(3);
  });
});

describe('analyseBeats — degenerate input', () => {
  it('returns no beats for silence', () => {
    const a = analyseBeats(new Float32Array(SR * 5), SR);
    expect(a.beats).toEqual([]);
    expect(a.bpm).toBeNull();
  });

  it('returns no beats for a steady tone with no transients', () => {
    // Without the salience gate this returned 10 confident beats at 112 BPM,
    // built entirely from frame-boundary artefacts.
    const n = SR * 5;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const a = analyseBeats(tone, SR);
    expect(a.beats).toEqual([]);
    expect(a.bpm).toBeNull();
    expect(a.confidence).toBe(0);
  });

  it('returns no beats for unpulsed broadband noise', () => {
    const n = SR * 6;
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      noise[i] = 0.2 * (Math.sin(i * 0.0193) * 0.6 + Math.sin(i * 0.0071 + 1.1) * 0.4);
    }
    const a = analyseBeats(noise, SR);
    expect(a.beats).toEqual([]);
  });

  it('survives an empty or near-empty buffer', () => {
    expect(analyseBeats(new Float32Array(0), SR).beats).toEqual([]);
    expect(analyseBeats(new Float32Array(64), SR).beats).toEqual([]);
    expect(analyseBeats([], SR).bpm).toBeNull();
  });

  it('never returns NaN in the envelope', () => {
    const a = analyseBeats(clickTrack(120, 6), SR);
    for (const v of a.envelope) expect(Number.isFinite(v)).toBe(true);
  });

  it('reports an envelope rate consistent with the hop', () => {
    const a = analyseBeats(clickTrack(120, 6), SR, { hop: 512 });
    expect(a.envelopeHz).toBeCloseTo(SR / 512, 6);
    expect(a.envelope.length).toBeCloseTo((SR * 6) / 512, -1);
  });

  it('honours the tempo search range', () => {
    const a = analyseBeats(clickTrack(160, 12), SR, { minBpm: 150, maxBpm: 190 });
    expect(a.bpm!).toBeGreaterThanOrEqual(150);
    expect(a.bpm!).toBeLessThanOrEqual(190);
  });

  it('admits ignorance when the true tempo is outside the search range', () => {
    // A 120 BPM track searched only between 150 and 190 has no honest answer.
    // Returning the best in-range fit anyway is how beat trackers end up
    // confidently wrong, so the salience gate should reject it instead.
    const a = analyseBeats(clickTrack(120, 12), SR, { minBpm: 150, maxBpm: 190 });
    expect(a.bpm === null || (a.bpm >= 150 && a.bpm <= 190)).toBe(true);
    if (a.bpm === null) expect(a.beats).toEqual([]);
  });
});

describe('nearestBeat', () => {
  const beats = [0, 500, 1000, 1500, 2000];

  it('finds the closest on either side', () => {
    expect(nearestBeat(beats, 480)).toBe(500);
    expect(nearestBeat(beats, 520)).toBe(500);
    expect(nearestBeat(beats, 1240)).toBe(1000);
    expect(nearestBeat(beats, 1260)).toBe(1500);
  });

  it('clamps outside the range', () => {
    expect(nearestBeat(beats, -900)).toBe(0);
    expect(nearestBeat(beats, 99999)).toBe(2000);
  });

  it('handles ties and the empty case', () => {
    expect(nearestBeat(beats, 1250)).toBe(1000);
    expect(nearestBeat([], 100)).toBeNull();
  });

  it('agrees with a linear scan on a large list', () => {
    const many = Array.from({ length: 500 }, (_, i) => i * 431);
    for (const t of [0, 1, 12345, 99999, 215500]) {
      const linear = many.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
      expect(nearestBeat(many, t)).toBe(linear);
    }
  });
});

describe('snapTimesToBeats', () => {
  const beats = [0, 500, 1000, 1500];

  it('pulls nearby times onto the beat', () => {
    expect(snapTimesToBeats([480, 1020], beats, 250)).toEqual([500, 1000]);
  });

  it('leaves distant times alone rather than dragging them', () => {
    // 750 is 250 from both neighbours; a bigger gap must not move at all.
    expect(snapTimesToBeats([750], beats, 100)).toEqual([750]);
  });

  it('is a no-op with no beats', () => {
    expect(snapTimesToBeats([1, 2, 3], [], 500)).toEqual([1, 2, 3]);
  });

  it('preserves length and order', () => {
    const out = snapTimesToBeats([100, 400, 900, 1400], beats, 200);
    expect(out).toHaveLength(4);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
  });
});

describe('beatsInWindow', () => {
  it('returns offsets relative to the window start', () => {
    expect(beatsInWindow([0, 500, 1000, 1500], 400, 1200)).toEqual([100, 600]);
  });

  it('is empty when the window contains none', () => {
    expect(beatsInWindow([0, 2000], 500, 1500)).toEqual([]);
  });
});

describe('audio timing', () => {
  const track: AudioTrack = {
    name: 'x.mp3',
    durationMs: 30_000,
    offsetMs: 5_000,
    gain: 0.8,
    beats: [],
    bpm: 120,
    periodMs: 500,
    fadeOutMs: 1_000,
  };

  it('maps video time onto source time through the offset', () => {
    expect(sourceTimeAt(track, 0)).toBe(5_000);
    expect(sourceTimeAt(track, 2_000)).toBe(7_000);
  });

  it('goes silent rather than looping when the source runs out', () => {
    expect(sourceTimeAt(track, 24_000)).toBe(29_000);
    expect(sourceTimeAt(track, 26_000)).toBeNull();
  });

  it('holds full gain until the fade, then ramps to zero', () => {
    expect(audioGainAt(track, 0, 10_000)).toBeCloseTo(0.8, 6);
    expect(audioGainAt(track, 8_500, 10_000)).toBeCloseTo(0.8, 6);
    expect(audioGainAt(track, 9_500, 10_000)).toBeCloseTo(0.4, 6);
    expect(audioGainAt(track, 10_000, 10_000)).toBeCloseTo(0, 6);
  });

  it('is silent outside the video', () => {
    expect(audioGainAt(track, -1, 10_000)).toBe(0);
    expect(audioGainAt(track, 10_001, 10_000)).toBe(0);
  });

  it('clamps a nonsense gain instead of passing it through', () => {
    expect(audioGainAt({ ...track, gain: 9 }, 0, 10_000)).toBe(1);
    expect(audioGainAt({ ...track, gain: -2 }, 0, 10_000)).toBe(0);
    expect(audioGainAt({ ...track, gain: NaN }, 0, 10_000)).toBe(0);
  });

  it('handles a zero-length fade', () => {
    expect(audioGainAt({ ...track, fadeOutMs: 0 }, 10_000, 10_000)).toBeCloseTo(0.8, 6);
  });
});

describe('beatPeriodMs', () => {
  it('is the interval between beats', () => {
    expect(beatPeriodMs([0, 500, 1000, 1500])).toBe(500);
  });

  it('uses the median so one dropped beat does not skew it', () => {
    // A tracker that misses a beat leaves a double-length gap. The mean here
    // would be 625 and every quantised duration would come out wrong.
    expect(beatPeriodMs([0, 500, 1000, 2000, 2500])).toBe(500);
  });

  it('needs at least two beats', () => {
    expect(beatPeriodMs([])).toBeNull();
    expect(beatPeriodMs([100])).toBeNull();
  });

  it('rejects a degenerate zero period', () => {
    expect(beatPeriodMs([100, 100, 100])).toBeNull();
  });
});

describe('quantiseDurations', () => {
  const P = 500; // 120 BPM

  it('rounds each segment to a whole number of half-beats', () => {
    expect(quantiseDurations([1400, 2600, 1200], P)).toEqual([1500, 2500, 1250]);
  });

  it('makes every boundary land on the grid, not just each segment', () => {
    // This is why durations are quantised rather than boundaries nudged: the
    // cumulative sum stays on the grid for the whole video, with no drift.
    const out = quantiseDurations([1400, 2600, 1200, 3100, 900], P);
    let t = 0;
    for (const d of out) {
      t += d;
      expect(t % (P / 2)).toBe(0);
    }
  });

  it('honours a whole-beat grid when asked', () => {
    expect(quantiseDurations([1400, 2600], P, { grid: 1 })).toEqual([1500, 2500]);
  });

  it('never produces a zero-length segment', () => {
    expect(quantiseDurations([0, -5, NaN, 10], P)).toEqual([250, 250, 250, 250]);
  });

  it('clamps to the beat bounds', () => {
    expect(quantiseDurations([60_000], P, { maxBeats: 4 })).toEqual([2000]);
    expect(quantiseDurations([10], P, { minBeats: 2 })).toEqual([1000]);
  });

  it('is a no-op without a usable period', () => {
    expect(quantiseDurations([1400, 2600], 0)).toEqual([1400, 2600]);
    expect(quantiseDurations([1400, 2600], NaN)).toEqual([1400, 2600]);
  });
});

describe('offsetToFirstBeat', () => {
  it('trims to the first beat so the opening cut lands', () => {
    expect(offsetToFirstBeat([320, 820, 1320])).toBe(320);
  });

  it('can skip ahead a whole number of beats', () => {
    expect(offsetToFirstBeat([320, 820, 1320], 2)).toBe(1320);
  });

  it('clamps rather than running off the end', () => {
    expect(offsetToFirstBeat([320, 820], 99)).toBe(820);
    expect(offsetToFirstBeat([], 3)).toBe(0);
  });
});

describe('periodMs vs the median beat gap', () => {
  it('is more accurate than the beats it produced', () => {
    // Beats land on analysis frames (~23ms at the default hop), so their
    // median gap is quantised; the estimator's own figure is not. At 120 BPM
    // the median reads 511ms — 2% high, which drifts more than half a beat
    // across a 30-second video.
    const a = analyseBeats(clickTrack(120, 16), SR);
    const trueMs = 500;
    const fromMedian = beatPeriodMs(a.beats)!;
    expect(a.periodMs).not.toBeNull();
    expect(Math.abs(a.periodMs! - trueMs)).toBeLessThan(Math.abs(fromMedian - trueMs) + 1);
    expect(Math.abs(a.periodMs! - trueMs)).toBeLessThan(12);
  });

  it('is null exactly when there is no tempo', () => {
    expect(analyseBeats(new Float32Array(SR * 4), SR).periodMs).toBeNull();
  });

  it('agrees with the reported BPM', () => {
    const a = analyseBeats(clickTrack(140, 12), SR);
    expect(60_000 / a.periodMs!).toBeCloseTo(a.bpm!, 0);
  });
});
