import { describe, expect, it } from 'vitest';
import {
  ARC,
  AUTO_FILL,
  BEARING_MODES,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_PRESETS,
  autoStopZooms,
  cameraAt,
  clampArc,
  clampOrbit,
  clampZoom,
  compileTrip,
  isBearingMode,
  travelBearings,
  zoomForSpan,
  zoomPreset,
  type TripStop,
} from '../src';

const BKK: TripStop = { name: 'Bangkok', coordinate: [100.5018, 13.7563] };
const TYO: TripStop = { name: 'Tokyo', coordinate: [139.6917, 35.6895] };
const PAR: TripStop = { name: 'Paris', coordinate: [2.3522, 48.8566] };
const LYO: TripStop = { name: 'Lyon', coordinate: [4.8357, 45.764] };
const NYC: TripStop = { name: 'New York', coordinate: [-74.006, 40.7128] };

describe('zoomForSpan', () => {
  it('halving the span adds exactly one zoom level', () => {
    const a = zoomForSpan(400_000, 720, 0);
    const b = zoomForSpan(200_000, 720, 0);
    expect(b - a).toBeCloseTo(1, 6);
  });

  it('doubling the viewport adds exactly one zoom level', () => {
    const a = zoomForSpan(400_000, 720, 0);
    const b = zoomForSpan(400_000, 1440, 0);
    expect(b - a).toBeCloseTo(1, 6);
  });

  it('agrees with the known 512px web-mercator scale at the equator', () => {
    // The world is 512px wide at zoom 0, so one pixel is world/512 metres.
    // At zoom 4 a 720px viewport therefore spans world/512 * 720 / 16 metres.
    const world = 40075016.686;
    const spanAtZoom4 = ((world / 512) * 720) / 16;
    expect(zoomForSpan(spanAtZoom4, 720, 0, 1)).toBeCloseTo(4, 6);
  });

  it('pulls back at high latitude for the same ground distance', () => {
    // Mercator's local scale factor is 1/cos(lat): the same ground distance
    // draws twice as long at 60°N as at the equator, so the camera has to sit
    // one zoom level further out (cos 60° = 0.5, and halving scale = -1 zoom).
    const equator = zoomForSpan(200_000, 720, 0);
    const sixty = zoomForSpan(200_000, 720, 60);
    expect(sixty).toBeLessThan(equator);
    expect(equator - sixty).toBeCloseTo(1, 6);
  });

  it('clamps rather than returning infinity for degenerate input', () => {
    expect(zoomForSpan(0, 720, 0)).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(zoomForSpan(1e-9, 720, 0)).toBeLessThanOrEqual(MAX_ZOOM);
    expect(zoomForSpan(1e12, 720, 0)).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(Number.isFinite(zoomForSpan(NaN, 720, 0))).toBe(true);
  });

  it('is monotonically wider with latitude, and symmetric about the equator', () => {
    const zs = [0, 20, 40, 60, 80].map((lat) => zoomForSpan(100_000, 720, lat));
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeLessThan(zs[i - 1]!);
    expect(zoomForSpan(100_000, 720, -55)).toBeCloseTo(
      zoomForSpan(100_000, 720, 55),
      6,
    );
  });
});

describe('autoStopZooms', () => {
  it('frames a short trip closer than a long one', () => {
    const short = autoStopZooms([PAR, LYO], 720);
    const long = autoStopZooms([BKK, TYO], 720);
    expect(short[0]!).toBeGreaterThan(long[0]! + 2);
  });

  it('frames each stop by its SHORTEST adjacent leg', () => {
    // Paris -> Lyon (short) -> New York (long). Lyon sits between them and
    // must be framed by the short hop, not the transatlantic one.
    const zs = autoStopZooms([PAR, LYO, NYC], 720);
    const pairwise = autoStopZooms([PAR, LYO], 720);
    expect(zs[1]!).toBeCloseTo(pairwise[1]!, 6);
    expect(zs[2]!).toBeLessThan(zs[1]!);
  });

  it('returns one zoom per stop, always in range', () => {
    const zs = autoStopZooms([PAR, LYO, NYC, BKK, TYO], 720);
    expect(zs).toHaveLength(5);
    for (const z of zs) {
      expect(z).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(z).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });

  it('survives duplicate coordinates instead of returning Infinity', () => {
    const zs = autoStopZooms([PAR, { ...PAR, name: 'Paris again' }], 720);
    expect(zs.every((z) => Number.isFinite(z))).toBe(true);
    expect(zs[0]!).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('handles the empty and single-stop cases', () => {
    expect(autoStopZooms([], 720)).toEqual([]);
    expect(autoStopZooms([PAR], 720)).toHaveLength(1);
  });

  it('a bigger fill factor means a wider view', () => {
    const tight = autoStopZooms([PAR, LYO], 720, 1);
    const loose = autoStopZooms([PAR, LYO], 720, 4);
    expect(loose[0]!).toBeGreaterThan(tight[0]!);
    expect(AUTO_FILL).toBeGreaterThan(1);
  });
});

describe('travelBearings', () => {
  it('points each stop along the leg that arrives at it', () => {
    const bs = travelBearings([PAR, LYO, NYC]);
    expect(bs).toHaveLength(3);
    // Paris -> Lyon is roughly south-east.
    expect(bs[1]!).toBeGreaterThan(90);
    expect(bs[1]!).toBeLessThan(180);
    // Lyon -> New York is roughly north-west (great-circle initial heading).
    expect(bs[2]!).toBeGreaterThan(270);
  });

  it('gives the first stop the first leg heading, not zero', () => {
    const bs = travelBearings([PAR, LYO]);
    expect(bs[0]!).toBeCloseTo(bs[1]!, 6);
  });

  it('degrades to zeros below two stops', () => {
    expect(travelBearings([PAR])).toEqual([0]);
    expect(travelBearings([])).toEqual([]);
  });
});

describe('clamps', () => {
  it('clampZoom keeps NaN out of the camera', () => {
    expect(clampZoom(NaN)).toBe(5);
    expect(clampZoom(-4)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });

  it('clampArc falls back to the MapLibre default', () => {
    expect(clampArc(undefined)).toBe(ARC.default);
    expect(clampArc(NaN)).toBe(ARC.default);
    expect(clampArc(0.1)).toBe(ARC.min);
    expect(clampArc(50)).toBe(ARC.max);
    expect(clampArc(2)).toBe(2);
  });

  it('clampOrbit rounds and bounds', () => {
    expect(clampOrbit(undefined)).toBe(0);
    expect(clampOrbit(45.4)).toBe(45);
    expect(clampOrbit(1000)).toBe(180);
    expect(clampOrbit(-1000)).toBe(-180);
  });

  it('zoomPreset falls back to auto for unknown ids', () => {
    expect(zoomPreset('nope').id).toBe('auto');
    expect(zoomPreset(undefined).zoom).toBeNull();
    expect(zoomPreset('city').zoom).toBe(10.5);
  });

  it('preset zooms are ordered from closest to widest', () => {
    const named = ZOOM_PRESETS.filter((p) => p.zoom !== null).map((p) => p.zoom!);
    for (let i = 1; i < named.length; i++) expect(named[i]!).toBeLessThan(named[i - 1]!);
  });

  it('isBearingMode rejects anything else', () => {
    expect(BEARING_MODES.map((m) => m.id)).toEqual(['fixed', 'travel']);
    expect(isBearingMode('travel')).toBe(true);
    expect(isBearingMode('spin')).toBe(false);
  });
});

describe('compileTrip camera options', () => {
  const fmt = { width: 1280, height: 720, fps: 30 };

  it('auto framing beats a fixed zoom on a short trip', () => {
    const auto = compileTrip('t', [PAR, LYO], { format: fmt, zoomPreset: 'auto' });
    const fixed = compileTrip('t', [PAR, LYO], { format: fmt, stopZoom: 4.4 });
    expect(auto.camera[0]!.camera.zoom).toBeGreaterThan(
      fixed.camera[0]!.camera.zoom + 2,
    );
  });

  it('a named preset pins every stop to the same zoom', () => {
    const p = compileTrip('t', [PAR, LYO, NYC], { format: fmt, zoomPreset: 'city' });
    for (const k of p.camera) expect(k.camera.zoom).toBeCloseTo(10.5, 6);
  });

  it('per-stop zoom overrides the preset', () => {
    const p = compileTrip('t', [PAR, LYO], {
      format: fmt,
      zoomPreset: 'city',
      stopZooms: [null, 14],
    });
    expect(p.camera[0]!.camera.zoom).toBeCloseTo(10.5, 6);
    // The arrival keyframe at Lyon is the second-to-last (a closing keyframe
    // is appended so the final dwell exists).
    expect(p.camera[p.camera.length - 1]!.camera.zoom).toBeCloseTo(14, 6);
  });

  it('defaults to the legacy fixed zoom when no preset is given', () => {
    const p = compileTrip('t', [PAR, LYO], { format: fmt });
    expect(p.camera[0]!.camera.zoom).toBeCloseTo(5.2, 6);
  });

  it('carries the arc onto travel segments only', () => {
    const p = compileTrip('t', [PAR, LYO], { format: fmt, arc: 2.5 });
    const withRho = p.camera.filter((k) => k.rho !== undefined);
    expect(withRho).toHaveLength(1); // one leg
    expect(withRho[0]!.rho).toBe(2.5);
  });

  it('clamps an absurd arc rather than passing it through', () => {
    const p = compileTrip('t', [PAR, LYO], { format: fmt, arc: 99 });
    expect(p.camera.find((k) => k.rho !== undefined)!.rho).toBe(ARC.max);
  });

  it('a higher arc pulls the camera further out mid-leg', () => {
    const flat = compileTrip('t', [PAR, NYC], { format: fmt, arc: 0.9, zoomPreset: 'auto' });
    const tall = compileTrip('t', [PAR, NYC], { format: fmt, arc: 3, zoomPreset: 'auto' });
    const mid = (p: typeof flat) => {
      const legStart = p.camera[1]!.tMs;
      const legEnd = p.camera[2]!.tMs;
      return cameraAt(p, (legStart + legEnd) / 2).zoom;
    };
    expect(mid(tall)).toBeLessThan(mid(flat));
  });

  it('fixed bearing mode holds one heading throughout', () => {
    const p = compileTrip('t', [PAR, LYO, NYC], { format: fmt, bearing: 30 });
    for (const k of p.camera) expect(k.camera.bearing).toBeCloseTo(30, 6);
  });

  it('travel mode turns during the dwell, not during the flight', () => {
    const p = compileTrip('t', [PAR, LYO, NYC], {
      format: fmt,
      bearingMode: 'travel',
      dwellMs: 1000,
      legMs: 2000,
    });
    // Keyframes: [depart0, depart0', arrive1, depart1, arrive2, close]
    // Each travel leg's two ends must share a heading...
    const legPairs: [number, number][] = [[1, 2], [3, 4]];
    for (const [a, b] of legPairs) {
      expect(p.camera[b]!.camera.bearing).toBeCloseTo(p.camera[a]!.camera.bearing, 6);
    }
    // ...and the turn happens across the dwell at Lyon.
    expect(p.camera[3]!.camera.bearing).not.toBeCloseTo(p.camera[2]!.camera.bearing, 1);
  });

  it('orbit rotates across every dwell including the last stop', () => {
    const p = compileTrip('t', [PAR, LYO], {
      format: fmt,
      orbitDeg: 90,
      dwellMs: 1000,
    });
    expect(p.camera[1]!.camera.bearing).toBeCloseTo(90, 6);
    const last = p.camera[p.camera.length - 1]!;
    const arrival = p.camera[p.camera.length - 2]!;
    expect(last.tMs).toBeGreaterThan(arrival.tMs);
    expect(last.camera.bearing).toBeCloseTo(90, 6);
  });

  it('the orbit actually moves the camera between those keyframes', () => {
    const p = compileTrip('t', [PAR, LYO], { format: fmt, orbitDeg: 90, dwellMs: 1000 });
    const a = p.camera[0]!.tMs;
    const b = p.camera[1]!.tMs;
    const mid = cameraAt(p, (a + b) / 2).bearing;
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(85);
  });

  it('per-stop bearing overrides beat the mode', () => {
    const p = compileTrip('t', [PAR, LYO], {
      format: fmt,
      bearingMode: 'travel',
      stopBearings: [270, 270],
    });
    for (const k of p.camera) expect(k.camera.bearing).toBeCloseTo(270, 6);
  });

  it('normalises negative and over-360 bearings', () => {
    const p = compileTrip('t', [PAR, LYO], { format: fmt, stopBearings: [-90, 450] });
    expect(p.camera[0]!.camera.bearing).toBeCloseTo(270, 6);
    expect(p.camera[p.camera.length - 1]!.camera.bearing).toBeCloseTo(90, 6);
  });

  it('per-stop pitch overrides the global tilt and stays legal', () => {
    const p = compileTrip('t', [PAR, LYO], {
      format: fmt,
      pitch: 20,
      stopPitches: [null, 200],
    });
    expect(p.camera[0]!.camera.pitch).toBe(20);
    expect(p.camera[p.camera.length - 1]!.camera.pitch).toBe(85);
  });

  it('applies leg easing overrides ahead of the global one', () => {
    const p = compileTrip('t', [PAR, LYO, NYC], {
      format: fmt,
      travelEasing: 'linear',
      legEasings: [null, 'easeInCubic'],
    });
    const travel = p.camera.filter((k) => k.rho !== undefined);
    expect(travel[0]!.easing).toBe('linear');
    expect(travel[1]!.easing).toBe('easeInCubic');
  });

  it('frames a vertical format from its shorter axis', () => {
    const wide = compileTrip('t', [PAR, LYO], {
      format: { width: 1280, height: 720, fps: 30 },
      zoomPreset: 'auto',
    });
    const tall = compileTrip('t', [PAR, LYO], {
      format: { width: 720, height: 1280, fps: 30 },
      zoomPreset: 'auto',
    });
    // Both have a 720px short axis, so both frame the trip identically.
    expect(tall.camera[0]!.camera.zoom).toBeCloseTo(wide.camera[0]!.camera.zoom, 6);
  });

  it('the closing keyframe never shortens the video', () => {
    const p = compileTrip('t', [PAR, LYO], { format: fmt });
    const last = p.camera[p.camera.length - 1]!;
    expect(p.format.durationMs).toBeGreaterThanOrEqual(last.tMs);
  });

  it('camera keyframes stay in chronological order', () => {
    const p = compileTrip('t', [PAR, LYO, NYC, BKK], {
      format: fmt,
      zoomPreset: 'auto',
      orbitDeg: 45,
      bearingMode: 'travel',
    });
    for (let i = 1; i < p.camera.length; i++) {
      expect(p.camera[i]!.tMs).toBeGreaterThanOrEqual(p.camera[i - 1]!.tMs);
    }
  });
});
