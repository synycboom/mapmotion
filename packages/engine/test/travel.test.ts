import { describe, expect, it } from 'vitest';
import {
  bearingBetween,
  codeToMode,
  compileTrip,
  cumulativeDistances,
  migrateLegacyMode,
  modeToCode,
  needsRouting,
  pointAtProgress,
  sceneAt,
  travelMode,
  TRAVEL_MODES,
  usesSuppliedGeometry,
  type LngLat,
  type TripStop,
} from '../src/index';

const A: LngLat = [0, 0];
const B: LngLat = [0, 1]; // due north
const C: LngLat = [1, 0]; // due east

const STOPS: TripStop[] = [
  { name: 'Bangkok', coordinate: [100.5018, 13.7563] },
  { name: 'Chiang Mai', coordinate: [98.9853, 18.7883] },
];

describe('bearingBetween', () => {
  it('reports cardinal directions correctly', () => {
    expect(bearingBetween(A, B)).toBeCloseTo(0, 1); // north
    expect(bearingBetween(A, C)).toBeCloseTo(90, 1); // east
    expect(bearingBetween(B, A)).toBeCloseTo(180, 1); // south
    expect(bearingBetween(C, A)).toBeCloseTo(270, 1); // west
  });

  it('always returns 0..360', () => {
    for (const [p, q] of [
      [A, B],
      [B, A],
      [A, C],
      [C, A],
      [[-179, 10] as LngLat, [179, 10] as LngLat],
    ] as Array<[LngLat, LngLat]>) {
      const b = bearingBetween(p, q);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe('pointAtProgress', () => {
  const line: LngLat[] = [
    [0, 0],
    [0, 1],
    [1, 1],
  ];
  const cum = cumulativeDistances(line);

  it('returns the endpoints at 0 and 1', () => {
    expect(pointAtProgress(line, cum, 0)!.coordinate[1]).toBeCloseTo(0, 5);
    const end = pointAtProgress(line, cum, 1)!.coordinate;
    expect(end[0]).toBeCloseTo(1, 5);
    expect(end[1]).toBeCloseTo(1, 5);
  });

  it('clamps out-of-range progress', () => {
    expect(pointAtProgress(line, cum, -3)!.coordinate[1]).toBeCloseTo(0, 5);
    expect(pointAtProgress(line, cum, 9)!.coordinate[0]).toBeCloseTo(1, 5);
  });

  it('takes heading from the current segment, not the overall direction', () => {
    // Early on we are heading north; later we are heading east.
    expect(pointAtProgress(line, cum, 0.1)!.bearing).toBeCloseTo(0, 0);
    expect(pointAtProgress(line, cum, 0.9)!.bearing).toBeCloseTo(90, 0);
  });

  it('advances monotonically along the line', () => {
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.05) {
      const at = pointAtProgress(line, cum, p)!;
      const travelled = at.coordinate[1] + at.coordinate[0];
      expect(travelled).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = travelled;
    }
  });

  it('handles degenerate input without throwing', () => {
    expect(pointAtProgress([], [], 0.5)).toBeNull();
    expect(pointAtProgress([A], [0], 0.5)!.coordinate).toEqual(A);
    // Zero-length line (duplicate points)
    const dup: LngLat[] = [A, A];
    expect(pointAtProgress(dup, cumulativeDistances(dup), 0.5)!.coordinate).toEqual(A);
  });
});

describe('travel mode registry', () => {
  it('every mode has a spec and a unique URL code', () => {
    const codes = new Set<string>();
    for (const m of TRAVEL_MODES) {
      expect(travelMode(m.id).id).toBe(m.id);
      const code = modeToCode(m.id);
      expect(codes.has(code)).toBe(false);
      codes.add(code);
      expect(codeToMode(code)).toBe(m.id);
    }
  });

  it('falls back to flight for unknown ids and codes', () => {
    expect(travelMode('nonsense').id).toBe('air');
    expect(codeToMode('?')).toBe('air');
    expect(codeToMode(undefined)).toBe('air');
  });

  it('knows which modes need a router', () => {
    expect(needsRouting('car')).toBe(true);
    expect(needsRouting('bike')).toBe(true);
    expect(needsRouting('walk')).toBe(true);
    expect(needsRouting('air')).toBe(false);
    expect(needsRouting('train')).toBe(false);
    expect(needsRouting('file')).toBe(false);
  });

  it('knows which modes animate supplied geometry', () => {
    expect(usesSuppliedGeometry('car')).toBe(true);
    expect(usesSuppliedGeometry('file')).toBe(true);
    expect(usesSuppliedGeometry('air')).toBe(false);
  });

  it('maps legacy values so old links keep working', () => {
    expect(migrateLegacyMode('flight')).toBe('air');
    expect(migrateLegacyMode('drive')).toBe('car');
    expect(migrateLegacyMode('track')).toBe('file');
    expect(migrateLegacyMode('car')).toBe('car');
    expect(migrateLegacyMode(undefined)).toBe('air');
  });
});

describe('compile with travel modes', () => {
  it('direct mode draws a straight two-point line', () => {
    const p = compileTrip('t', STOPS, { legModes: ['direct'] });
    expect(p.routes[0]!.coordinates).toHaveLength(2);
  });

  it('flight mode draws an arc', () => {
    const p = compileTrip('t', STOPS, { legModes: ['air'] });
    expect(p.routes[0]!.coordinates).toHaveLength(97);
  });

  it('train and ferry fall back to an arc (no routing engine)', () => {
    for (const mode of ['train', 'sea'] as const) {
      expect(compileTrip('t', STOPS, { legModes: [mode] }).routes[0]!.coordinates)
        .toHaveLength(97);
    }
  });

  it('attaches a vehicle matching the mode', () => {
    expect(compileTrip('t', STOPS, { legModes: ['air'] }).routes[0]!.vehicle?.icon)
      .toBe('plane');
    expect(compileTrip('t', STOPS, { legModes: ['car'] }).routes[0]!.vehicle?.icon)
      .toBe('car');
    expect(compileTrip('t', STOPS, { legModes: ['bike'] }).routes[0]!.vehicle?.icon)
      .toBe('bike');
  });

  it('omits the vehicle for direct mode and when disabled', () => {
    expect(compileTrip('t', STOPS, { legModes: ['direct'] }).routes[0]!.vehicle)
      .toBeUndefined();
    expect(
      compileTrip('t', STOPS, { legModes: ['car'], showVehicles: false }).routes[0]!.vehicle,
    ).toBeUndefined();
  });

  it('accepts legacy mode strings', () => {
    const p = compileTrip('t', STOPS, { legModes: ['flight'] });
    expect(p.routes[0]!.mode).toBe('air');
    expect(p.routes[0]!.coordinates).toHaveLength(97);
  });

  it('carries router distance and duration onto the route', () => {
    const p = compileTrip('t', STOPS, {
      legModes: ['car'],
      legGeometries: [[STOPS[0]!.coordinate, [100, 16], STOPS[1]!.coordinate]],
      legDistances: [685_036],
      legDurations2: [30_722],
    });
    expect(p.routes[0]!.distanceMeters).toBe(685_036);
    expect(p.routes[0]!.durationSeconds).toBe(30_722);
  });

  it('uses a per-leg colour for both line and vehicle', () => {
    const p = compileTrip('t', STOPS, { legModes: ['car'], legColors: ['#00ff00'] });
    expect(p.routes[0]!.color).toBe('#00ff00');
    expect(p.routes[0]!.vehicle?.color).toBe('#00ff00');
  });
});

describe('vehicle motion through sceneAt', () => {
  const project = compileTrip('t', STOPS, { legModes: ['air'] });
  const route = project.routes[0]!;

  it('is hidden before and after the leg', () => {
    expect(sceneAt(project, route.startMs - 100).vehicles[route.id]?.opacity ?? 0).toBe(0);
    expect(sceneAt(project, route.endMs + 100).vehicles[route.id]?.opacity ?? 0).toBe(0);
  });

  it('is visible and moving during the leg', () => {
    const mid = sceneAt(project, (route.startMs + route.endMs) / 2).vehicles[route.id]!;
    expect(mid.opacity).toBe(1);
    expect(mid.icon).toBe('plane');

    const quarter = sceneAt(project, route.startMs + (route.endMs - route.startMs) * 0.25)
      .vehicles[route.id]!;
    // It has actually travelled between the two samples.
    expect(quarter.coordinate).not.toEqual(mid.coordinate);
  });

  it('fades in and out rather than popping', () => {
    const justIn = sceneAt(project, route.startMs + (route.endMs - route.startMs) * 0.02)
      .vehicles[route.id]!;
    expect(justIn.opacity).toBeGreaterThan(0);
    expect(justIn.opacity).toBeLessThan(1);
  });

  it('faces its direction of travel', () => {
    const mid = sceneAt(project, (route.startMs + route.endMs) / 2).vehicles[route.id]!;
    // Bangkok -> Chiang Mai is roughly north-west.
    expect(mid.bearing).toBeGreaterThan(270);
    expect(mid.bearing).toBeLessThan(360);
  });

  it('stays deterministic', () => {
    expect(sceneAt(project, 2345)).toEqual(sceneAt(project, 2345));
  });

  it('produces no vehicle entry when the mode has none', () => {
    const p = compileTrip('t', STOPS, { legModes: ['direct'] });
    expect(sceneAt(p, p.routes[0]!.startMs + 100).vehicles).toEqual({});
  });
});
