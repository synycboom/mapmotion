import { describe, expect, it } from 'vitest';
import { compileTrip, type TripStop } from '../src/index';

const STOPS: TripStop[] = [
  { name: 'A', coordinate: [0, 0] },
  { name: 'B', coordinate: [10, 10] },
  { name: 'C', coordinate: [20, 20] },
];

const legLength = (p: ReturnType<typeof compileTrip>, i: number) =>
  p.routes[i]!.endMs - p.routes[i]!.startMs;

describe('per-segment timing overrides', () => {
  it('derives durations from distance by default', () => {
    const p = compileTrip('t', STOPS);
    expect(legLength(p, 0)).toBeGreaterThan(0);
    expect(legLength(p, 1)).toBeGreaterThan(0);
  });

  it('honours a per-leg duration', () => {
    const p = compileTrip('t', STOPS, { legDurations: [5000, null] });
    expect(legLength(p, 0)).toBe(5000);
    // The untouched leg keeps its derived value.
    expect(legLength(p, 1)).toBe(legLength(compileTrip('t', STOPS), 1));
  });

  it('shifts everything after a retimed leg', () => {
    const base = compileTrip('t', STOPS);
    const longer = compileTrip('t', STOPS, {
      legDurations: [legLength(base, 0) + 4000],
    });
    expect(longer.routes[1]!.startMs).toBe(base.routes[1]!.startMs + 4000);
    expect(longer.format.durationMs).toBe(base.format.durationMs + 4000);
  });

  it('honours per-stop dwell', () => {
    const base = compileTrip('t', STOPS, { dwellMs: 1000 });
    const p = compileTrip('t', STOPS, { dwellMs: 1000, stopDwells: [3000] });
    expect(p.routes[0]!.startMs).toBe(base.routes[0]!.startMs + 2000);
  });

  it('clamps absurd or invalid durations instead of breaking the timeline', () => {
    for (const bad of [0, -5000, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const p = compileTrip('t', STOPS, { legDurations: [bad as number] });
      const len = legLength(p, 0);
      expect(Number.isFinite(len)).toBe(true);
      expect(len).toBeGreaterThanOrEqual(200);
      expect(len).toBeLessThanOrEqual(60_000);
    }
  });

  it('treats null/undefined as "derive it"', () => {
    const base = compileTrip('t', STOPS);
    for (const v of [null, undefined]) {
      const p = compileTrip('t', STOPS, { legDurations: [v] });
      expect(legLength(p, 0)).toBe(legLength(base, 0));
    }
  });

  it('keeps markers aligned with retimed legs', () => {
    const p = compileTrip('t', STOPS, { legDurations: [7000, 7000] });
    // Each marker (after the first) enters just as its leg finishes.
    expect(p.markers[1]!.enterMs).toBeCloseTo(p.routes[0]!.endMs - 150, 0);
    expect(p.markers[2]!.enterMs).toBeCloseTo(p.routes[1]!.endMs - 150, 0);
  });

  it('keeps the timeline monotonic under overrides', () => {
    const p = compileTrip('t', STOPS, {
      legDurations: [400, 20_000],
      stopDwells: [200, 9000, 300],
    });
    const times = p.camera.map((k) => k.tMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const r of p.routes) expect(r.endMs).toBeGreaterThan(r.startMs);
    expect(p.format.durationMs).toBeGreaterThan(times[times.length - 1]!);
  });

  it('ignores extra override entries beyond the leg count', () => {
    expect(() =>
      compileTrip('t', STOPS, { legDurations: [1000, 1000, 1000, 1000] }),
    ).not.toThrow();
  });
});
