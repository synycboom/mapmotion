import type { CameraState, LngLat } from './types';

/**
 * Zoom-aware camera flight interpolation — van Wijk & Nuij (2003),
 * "Smooth and efficient zooming and panning", the same math behind
 * MapLibre/Mapbox `flyTo`. Implemented as a pure function so preview and
 * export interpolate identically frame by frame.
 */

const WORLD = 512; // world size in px at zoom 0 (tileSize 512)

export function project([lng, lat]: LngLat): [number, number] {
  const x = ((lng + 180) / 360) * WORLD;
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
  return [x, y];
}

export function unproject([x, y]: [number, number]): LngLat {
  const lng = (x / WORLD) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / WORLD;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angular interpolation for bearing, in degrees. */
export function lerpBearing(a: number, b: number, t: number): number {
  let diff = (b - a) % 360;
  if (diff > 180) diff -= 360;
  else if (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
}

export interface FlightOptions {
  /** van Wijk rho — controls how high the camera arcs. MapLibre default 1.42. */
  rho?: number;
  /** Viewport size in px; affects the arc shape. */
  size?: [number, number];
}

/**
 * Interpolate the full camera state along a flight path.
 * @param t normalized progress in [0, 1] (apply easing BEFORE calling).
 */
export function flyInterpolate(
  from: CameraState,
  to: CameraState,
  t: number,
  opts: FlightOptions = {},
): CameraState {
  if (t <= 0) return { ...from, center: [...from.center] };
  if (t >= 1) return { ...to, center: [...to.center] };

  const rho = opts.rho ?? 1.42;
  const [vw, vh] = opts.size ?? [1280, 720];

  // Work in world pixel coords scaled to the START zoom.
  const startScale = Math.pow(2, from.zoom);
  const p0raw = project(from.center);
  const p1raw = project(to.center);
  const p0: [number, number] = [p0raw[0] * startScale, p0raw[1] * startScale];
  const p1: [number, number] = [p1raw[0] * startScale, p1raw[1] * startScale];

  const w0 = Math.max(vw, vh);
  const w1 = w0 / Math.pow(2, to.zoom - from.zoom);
  const u1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);

  let zoom: number;
  let u: number; // distance travelled along the ground path, in start-zoom px

  const rho2 = rho * rho;

  if (u1 < 1e-6) {
    // Pure zoom (no pan): exponential zoom interpolation.
    if (Math.abs(w0 - w1) < 1e-9) {
      zoom = from.zoom;
    } else {
      const k = w1 < w0 ? -1 : 1;
      const S = Math.abs(Math.log(w1 / w0)) / rho;
      const s = t * S;
      // w(s) = w0 * exp(k*rho*s)  =>  zoom = from.zoom + log2(w0/w(s)) = from.zoom - k*rho*s/ln2
      zoom = from.zoom - (k * rho * s) / Math.LN2;
    }
    u = 0;
  } else {
    const b = (i: 0 | 1): number => {
      const wi = i === 0 ? w0 : w1;
      const sign = i === 0 ? 1 : -1;
      return (
        (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * u1 * u1) /
        (2 * wi * rho2 * u1)
      );
    };
    const r = (i: 0 | 1): number => {
      const bi = b(i);
      return Math.log(Math.sqrt(bi * bi + 1) - bi);
    };
    const r0 = r(0);
    const r1 = r(1);
    const S = (r1 - r0) / rho;
    const s = t * S;

    const w = (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0);
    u = (w0 / rho2) * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0));
    zoom = from.zoom + Math.log2(w0 / w);
  }

  const frac = u1 < 1e-6 ? t : u / u1;
  const cx = lerp(p0[0], p1[0], frac) / startScale;
  const cy = lerp(p0[1], p1[1], frac) / startScale;

  return {
    center: unproject([cx, cy]),
    zoom,
    bearing: lerpBearing(from.bearing, to.bearing, t),
    pitch: lerp(from.pitch, to.pitch, t),
  };
}
