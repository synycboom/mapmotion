import { describe, expect, it } from 'vitest';
import {
  compileTrip,
  simplifyLine,
  type LngLat,
  type TripStop,
} from '../src/index';

const BKK: LngLat = [100.5018, 13.7563];
const CNX: LngLat = [98.9853, 18.7883];

const STOPS: TripStop[] = [
  { name: 'Bangkok', coordinate: BKK },
  { name: 'Chiang Mai', coordinate: CNX },
];

describe('simplifyLine', () => {
  it('leaves degenerate lines alone', () => {
    expect(simplifyLine([])).toEqual([]);
    expect(simplifyLine([BKK])).toEqual([BKK]);
    expect(simplifyLine([BKK, CNX])).toEqual([BKK, CNX]);
  });

  it('always keeps the endpoints', () => {
    const noisy: LngLat[] = Array.from({ length: 200 }, (_, i) => [
      100 + i * 0.01,
      13 + Math.sin(i) * 0.0001,
    ]);
    const out = simplifyLine(noisy, 0.01);
    expect(out[0]).toEqual(noisy[0]);
    expect(out[out.length - 1]).toEqual(noisy[noisy.length - 1]);
  });

  it('collapses a nearly-straight line to its endpoints', () => {
    const straight: LngLat[] = Array.from({ length: 100 }, (_, i) => [
      100 + i * 0.01,
      13 + i * 0.00001,
    ]);
    expect(simplifyLine(straight, 0.01)).toHaveLength(2);
  });

  it('preserves genuine corners', () => {
    const L: LngLat[] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    expect(simplifyLine(L, 0.01)).toHaveLength(3);
  });

  it('cuts point count hard on realistic road-like geometry', () => {
    const road: LngLat[] = Array.from({ length: 3000 }, (_, i) => [
      100 + i * 0.001,
      13 + Math.sin(i / 40) * 0.02 + (i % 3) * 0.00002,
    ]);
    const out = simplifyLine(road, 0.0015);
    expect(out.length).toBeLessThan(road.length / 10);
    expect(out.length).toBeGreaterThan(2);
  });

  it('handles very long inputs without blowing the stack', () => {
    const long: LngLat[] = Array.from({ length: 60_000 }, (_, i) => [
      100 + i * 0.0001,
      13 + (i % 2) * 0.00005,
    ]);
    expect(() => simplifyLine(long)).not.toThrow();
  });

  it('does not mutate its input', () => {
    const src: LngLat[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    const copy = JSON.parse(JSON.stringify(src));
    simplifyLine(src, 0.5);
    expect(src).toEqual(copy);
  });
});

describe('compileTrip leg modes', () => {
  it('uses a great-circle arc by default', () => {
    const p = compileTrip('t', STOPS);
    expect(p.routes[0]!.coordinates).toHaveLength(97); // 96 segments + 1
  });

  it('uses supplied road geometry in drive mode', () => {
    const road: LngLat[] = [
      BKK,
      [100.2, 15.0],
      [99.8, 16.5],
      [99.2, 17.8],
      CNX,
    ];
    const p = compileTrip('t', STOPS, {
      legModes: ['drive'],
      legGeometries: [road],
    });
    const coords = p.routes[0]!.coordinates;
    expect(coords.length).toBeLessThanOrEqual(road.length);
    expect(coords[0]).toEqual(BKK);
    expect(coords[coords.length - 1]).toEqual(CNX);
    // Distinctly not the 97-point arc.
    expect(coords).not.toHaveLength(97);
  });

  it('falls back to an arc when drive geometry is missing', () => {
    for (const geom of [undefined, null, [], [BKK]] as const) {
      const p = compileTrip('t', STOPS, {
        legModes: ['drive'],
        legGeometries: [geom as never],
      });
      expect(p.routes[0]!.coordinates).toHaveLength(97);
    }
  });

  it('ignores geometry when the leg is a flight', () => {
    const p = compileTrip('t', STOPS, {
      legModes: ['flight'],
      legGeometries: [[BKK, [100, 16], CNX]],
    });
    expect(p.routes[0]!.coordinates).toHaveLength(97);
  });

  it('applies modes per leg independently', () => {
    const three: TripStop[] = [
      ...STOPS,
      { name: 'Phuket', coordinate: [98.3923, 7.8804] },
    ];
    const p = compileTrip('t', three, {
      legModes: ['drive', 'flight'],
      legGeometries: [[BKK, [100.1, 15.5], [99.4, 17.2], CNX], null],
    });
    expect(p.routes[0]!.coordinates).not.toHaveLength(97); // drive
    expect(p.routes[1]!.coordinates).toHaveLength(97); // flight
  });

  it('keeps timing consistent regardless of leg mode', () => {
    const arc = compileTrip('t', STOPS);
    const drive = compileTrip('t', STOPS, {
      legModes: ['drive'],
      legGeometries: [[BKK, [100.1, 15.5], CNX]],
    });
    expect(drive.format.durationMs).toBe(arc.format.durationMs);
    expect(drive.routes[0]!.startMs).toBe(arc.routes[0]!.startMs);
    expect(drive.routes[0]!.endMs).toBe(arc.routes[0]!.endMs);
  });
});
