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
