import { describe, expect, it } from 'vitest';
import {
  cameraAt,
  compileTrip,
  cumulativeDistances,
  distanceMeters,
  ease,
  easings,
  flyInterpolate,
  greatCircleArc,
  lerpBearing,
  project,
  sceneAt,
  sliceLine,
  unproject,
  type CameraState,
  type Project,
} from '../src/index';

const BKK: [number, number] = [100.5018, 13.7563];
const TYO: [number, number] = [139.6917, 35.6895];

describe('easing', () => {
  it('all easings hit 0 and 1 at the boundaries', () => {
    for (const fn of Object.values(easings)) {
      expect(fn(0)).toBeCloseTo(0, 9);
      expect(fn(1)).toBeCloseTo(1, 9);
    }
  });

  it('is monotonic on [0,1]', () => {
    for (const fn of Object.values(easings)) {
      let prev = -Infinity;
      for (let i = 0; i <= 100; i++) {
        const v = fn(i / 100);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it('ease clamps out-of-range t', () => {
    expect(ease('linear', -5)).toBe(0);
    expect(ease('linear', 5)).toBe(1);
  });
});

describe('projection', () => {
  it('project/unproject roundtrips', () => {
    for (const p of [BKK, TYO, [-122.4, 37.77], [0, 0], [179, -60]] as const) {
      const rt = unproject(project([p[0], p[1]]));
      expect(rt[0]).toBeCloseTo(p[0], 6);
      expect(rt[1]).toBeCloseTo(p[1], 6);
    }
  });
});

describe('bearing interpolation', () => {
  it('takes the shortest path across 0', () => {
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpBearing(10, 350, 0.5)).toBeCloseTo(0, 6);
    expect(lerpBearing(0, 180, 0.25)).toBeCloseTo(45, 6);
  });
});

describe('flyInterpolate (van Wijk)', () => {
  const from: CameraState = { center: BKK, zoom: 8, bearing: 0, pitch: 0 };
  const to: CameraState = { center: TYO, zoom: 8, bearing: 40, pitch: 30 };

  it('matches endpoints exactly', () => {
    const a = flyInterpolate(from, to, 0);
    const b = flyInterpolate(from, to, 1);
    expect(a).toEqual(from);
    expect(b).toEqual(to);
  });

  it('arcs out (zooms out) in the middle of a long pan', () => {
    const mid = flyInterpolate(from, to, 0.5);
    expect(mid.zoom).toBeLessThan(from.zoom - 1); // clearly zoomed out
    expect(mid.bearing).toBeCloseTo(20, 6);
    expect(mid.pitch).toBeCloseTo(15, 6);
    // Midpoint lies between the two lngs
    expect(mid.center[0]).toBeGreaterThan(BKK[0]);
    expect(mid.center[0]).toBeLessThan(TYO[0]);
  });

  it('zoom is continuous near the endpoints (no jumps)', () => {
    const near0 = flyInterpolate(from, to, 0.001);
    const near1 = flyInterpolate(from, to, 0.999);
    expect(Math.abs(near0.zoom - from.zoom)).toBeLessThan(0.2);
    expect(Math.abs(near1.zoom - to.zoom)).toBeLessThan(0.2);
  });

  it('handles pure zoom (same center)', () => {
    const zin: CameraState = { center: BKK, zoom: 4, bearing: 0, pitch: 0 };
    const zout: CameraState = { center: BKK, zoom: 10, bearing: 0, pitch: 0 };
    const mid = flyInterpolate(zin, zout, 0.5);
    expect(mid.center[0]).toBeCloseTo(BKK[0], 6);
    expect(mid.center[1]).toBeCloseTo(BKK[1], 6);
    expect(mid.zoom).toBeGreaterThan(4);
    expect(mid.zoom).toBeLessThan(10);
    expect(flyInterpolate(zin, zout, 1).zoom).toBe(10);
  });

  it('is deterministic', () => {
    const a = flyInterpolate(from, to, 0.37);
    const b = flyInterpolate(from, to, 0.37);
    expect(a).toEqual(b);
  });
});

describe('geo', () => {
  it('BKK→TYO distance is ~4600km', () => {
    const km = distanceMeters(BKK, TYO) / 1000;
    expect(km).toBeGreaterThan(4400);
    expect(km).toBeLessThan(4800);
  });

  it('great-circle arc endpoints match inputs', () => {
    const arc = greatCircleArc(BKK, TYO, 32);
    expect(arc.length).toBe(33);
    expect(arc[0]![0]).toBeCloseTo(BKK[0], 6);
    expect(arc[32]![1]).toBeCloseTo(TYO[1], 6);
  });

  it('sliceLine returns partial line with interpolated tip', () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 0]];
    const cum = cumulativeDistances(line);
    expect(sliceLine(line, cum, 0)).toEqual([]);
    expect(sliceLine(line, cum, 1)).toEqual(line);
    const half = sliceLine(line, cum, 0.5);
    const tip = half[half.length - 1]!;
    expect(tip[0]).toBeCloseTo(1, 3);
  });
});

describe('sceneAt', () => {
  const project: Project = compileTrip('test', [
    { name: 'Bangkok', coordinate: BKK },
    { name: 'Tokyo', coordinate: TYO },
  ]);

  it('route progress is 0 before start, 1 after end', () => {
    const route = project.routes[0]!;
    expect(sceneAt(project, route.startMs - 1).routeProgress[route.id]).toBe(0);
    expect(sceneAt(project, route.endMs + 1).routeProgress[route.id]).toBe(1);
  });

  it('markers pop in at enterMs', () => {
    const m = project.markers[1]!;
    expect(sceneAt(project, m.enterMs - 1).markers[m.id]!.opacity).toBe(0);
    expect(sceneAt(project, m.enterMs + 10_000).markers[m.id]!.opacity).toBe(1);
  });

  it('camera clamps to first/last keyframes', () => {
    const start = cameraAt(project, -100);
    const end = cameraAt(project, 10_000_000);
    expect(start.center[0]).toBeCloseTo(BKK[0], 6);
    expect(end.center[0]).toBeCloseTo(TYO[0], 6);
  });

  it('frame states are identical across evaluations (determinism)', () => {
    expect(sceneAt(project, 3210)).toEqual(sceneAt(project, 3210));
  });

  it('compileTrip produces a valid, ordered project', () => {
    expect(project.format.durationMs).toBeGreaterThan(0);
    const times = project.camera.map((k) => k.tMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(project.routes).toHaveLength(1);
    expect(project.markers).toHaveLength(2);
  });
});
