import type { LngLat } from './types';

const R = 6371008.8; // mean Earth radius, meters
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Haversine distance in meters. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Spherical linear interpolation between two points (great-circle path). */
export function slerp(a: LngLat, b: LngLat, t: number): LngLat {
  const φ1 = a[1] * D2R, λ1 = a[0] * D2R;
  const φ2 = b[1] * D2R, λ2 = b[0] * D2R;

  const v1 = [Math.cos(φ1) * Math.cos(λ1), Math.cos(φ1) * Math.sin(λ1), Math.sin(φ1)];
  const v2 = [Math.cos(φ2) * Math.cos(λ2), Math.cos(φ2) * Math.sin(λ2), Math.sin(φ2)];

  const dot = Math.min(1, Math.max(-1, v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!));
  const ω = Math.acos(dot);
  if (ω < 1e-9) return [...a];

  const sinω = Math.sin(ω);
  const k1 = Math.sin((1 - t) * ω) / sinω;
  const k2 = Math.sin(t * ω) / sinω;
  const x = k1 * v1[0]! + k2 * v2[0]!;
  const y = k1 * v1[1]! + k2 * v2[1]!;
  const z = k1 * v1[2]! + k2 * v2[2]!;

  const lat = Math.atan2(z, Math.hypot(x, y)) * R2D;
  const lng = Math.atan2(y, x) * R2D;
  return [lng, lat];
}

/** Great-circle arc between two points, as `segments + 1` coordinates. */
export function greatCircleArc(a: LngLat, b: LngLat, segments = 64): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i <= segments; i++) out.push(slerp(a, b, i / segments));
  return out;
}

/** Cumulative distances (meters) along a line; out[0] = 0. */
export function cumulativeDistances(coords: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(out[i - 1]! + distanceMeters(coords[i - 1]!, coords[i]!));
  }
  return out;
}

/**
 * Initial bearing from a to b, in degrees clockwise from north.
 * This is what a vehicle sprite is rotated by so it faces its direction of
 * travel.
 */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const φ1 = a[1] * D2R;
  const φ2 = b[1] * D2R;
  const Δλ = (b[0] - a[0]) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/**
 * Position and heading at `progress` (0..1) along a line.
 *
 * Heading is taken from the segment the point currently sits on rather than
 * from the overall start→end direction, so a vehicle turns as it follows a
 * winding road instead of pointing at its final destination the whole way.
 */
export function pointAtProgress(
  coords: readonly LngLat[],
  cumulative: readonly number[],
  progress: number,
): { coordinate: LngLat; bearing: number } | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    return { coordinate: [...coords[0]!] as LngLat, bearing: 0 };
  }

  const total = cumulative[cumulative.length - 1] ?? 0;
  const p = Math.min(1, Math.max(0, progress));

  if (total === 0) {
    return {
      coordinate: [...coords[0]!] as LngLat,
      bearing: bearingBetween(coords[0]!, coords[coords.length - 1]!),
    };
  }

  const target = total * p;

  // Find the segment containing `target`.
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i]! < target) i++;

  const prev = cumulative[i - 1]!;
  const segLen = cumulative[i]! - prev;
  const f = segLen === 0 ? 0 : (target - prev) / segLen;
  const a = coords[i - 1]!;
  const b = coords[i]!;

  return {
    coordinate: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
    bearing: bearingBetween(a, b),
  };
}

/**
 * Slice a line from its start to `progress` (0..1 of total length).
 * Returns at least 2 coordinates when progress > 0 (interpolates the tip).
 */
export function sliceLine(
  coords: LngLat[],
  cumulative: number[],
  progress: number,
): LngLat[] {
  if (coords.length < 2) return [...coords];
  const total = cumulative[cumulative.length - 1]!;
  if (progress <= 0 || total === 0) return [];
  if (progress >= 1) return [...coords];

  const target = total * progress;
  const out: LngLat[] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    if (cumulative[i]! <= target) {
      out.push(coords[i]!);
    } else {
      const prev = cumulative[i - 1]!;
      const segLen = cumulative[i]! - prev;
      const f = segLen === 0 ? 0 : (target - prev) / segLen;
      const a = coords[i - 1]!;
      const b = coords[i]!;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      break;
    }
  }
  return out;
}

/**
 * The point `meters` away from `origin` on a given bearing, along a great
 * circle.
 *
 * Spherical rather than a flat offset in degrees. A "circle" drawn by adding
 * a constant to longitude and latitude is an ellipse twice as wide as it is
 * tall at 60°N — which looks like a bug at exactly the latitudes most people
 * live at.
 */
export function destination(origin: LngLat, bearingDeg: number, meters: number): LngLat {
  const R = 6371008.8;
  const d = meters / R;
  const brg = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin[1] * Math.PI) / 180;
  const lng1 = (origin[0] * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );

  // Keep longitude in [-180, 180]; crossing the antimeridian otherwise
  // produces coordinates MapLibre draws all the way round the world.
  const lng = (((lng2 * 180) / Math.PI + 540) % 360) - 180;
  return [lng, (lat2 * 180) / Math.PI];
}
