import type { LngLat } from './types';
import { bearingBetween, distanceMeters } from './geo';

/**
 * Camera framing: how close the camera sits, how high it arcs between stops,
 * and which way it faces.
 *
 * All pure math on the same web-mercator convention as camera.ts — the world
 * is 512 CSS pixels wide at zoom 0, which is what MapLibre uses. Getting that
 * constant wrong silently biases every zoom by one level.
 */

/** Metres per pixel at the equator, zoom 0, 512px world. */
const EQUATOR_M_PER_PX = 40075016.686 / 512;

/** Zooms outside this range are either useless or unsupported by the tiles. */
export const MIN_ZOOM = 1.2;
export const MAX_ZOOM = 16;

export interface ZoomPreset {
  id: string;
  label: string;
  /** `null` means "work it out from the trip" — see autoStopZooms. */
  zoom: number | null;
  hint: string;
}

export const ZOOM_PRESETS: readonly ZoomPreset[] = [
  { id: 'auto', label: 'Auto', zoom: null, hint: 'Frame each stop from how far the next one is' },
  { id: 'street', label: 'Street', zoom: 14.5, hint: 'Individual buildings' },
  { id: 'district', label: 'District', zoom: 12.5, hint: 'Neighbourhoods' },
  { id: 'city', label: 'City', zoom: 10.5, hint: 'A whole city' },
  { id: 'region', label: 'Region', zoom: 8, hint: 'A metro area and its surroundings' },
  { id: 'country', label: 'Country', zoom: 5.2, hint: 'A country or small sea' },
  { id: 'continent', label: 'Continent', zoom: 3.2, hint: 'A continent' },
  { id: 'world', label: 'World', zoom: 1.6, hint: 'The whole globe' },
];

export function zoomPreset(id: string | undefined): ZoomPreset {
  return ZOOM_PRESETS.find((p) => p.id === id) ?? ZOOM_PRESETS[0]!;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 5;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * The zoom at which `meters` on the ground spans `fill` times the given
 * viewport dimension. `fill` above 1 means the span overflows the frame —
 * which is what you want for a stop, where the point is to look at the place
 * rather than at the whole journey.
 */
export function zoomForSpan(
  meters: number,
  viewportPx: number,
  latitudeDeg: number,
  fill = 1,
): number {
  if (!(meters > 0) || !(viewportPx > 0)) return 5;
  // Mercator is conformal with a local scale factor of 1/cos(lat), so a fixed
  // ground distance draws LONGER the further you are from the equator and the
  // camera has to sit further out to contain it. Clamp near the poles so the
  // correction can't blow up.
  const cos = Math.max(0.02, Math.cos((latitudeDeg * Math.PI) / 180));
  const mPerPxAtZ0 = EQUATOR_M_PER_PX * cos;
  return clampZoom(Math.log2((mPerPxAtZ0 * viewportPx * fill) / meters));
}

/**
 * How much of the frame a leg should span when the camera is parked at one of
 * its ends. Above 1 by design: at 2.2 you see roughly the last half of the
 * approach, which reads as "here is the place, and there is where we came
 * from" without shrinking the destination to a dot.
 */
export const AUTO_FILL = 2.2;

/**
 * Per-stop zoom derived from the trip itself.
 *
 * Each stop is framed by its SHORTEST adjacent leg, so a trip that mixes a
 * cross-continent flight with a short hop doesn't render the short hop from
 * orbit. A fixed zoom (the old behaviour) is fine for Bangkok→Tokyo and
 * absurd for Paris→Lyon; this is the difference between a map that looks
 * composed and one that looks like a default.
 */
export function autoStopZooms(
  stops: readonly { coordinate: LngLat }[],
  viewportPx: number,
  fill = AUTO_FILL,
): number[] {
  if (stops.length === 0) return [];
  if (stops.length === 1) return [clampZoom(9)];

  const legs = stops.slice(1).map((s, i) => distanceMeters(stops[i]!.coordinate, s.coordinate));

  return stops.map((s, i) => {
    const before = i > 0 ? legs[i - 1]! : Infinity;
    const after = i < legs.length ? legs[i]! : Infinity;
    const span = Math.min(before, after);
    // Two stops at the same coordinate would give a zero span and an
    // infinite zoom; fall back to a city view.
    if (!Number.isFinite(span) || span < 1) return clampZoom(10.5);
    return zoomForSpan(span, viewportPx, s.coordinate[1], fill);
  });
}

/**
 * van Wijk's rho — how high the camera arcs on a flight. 1.42 is the
 * MapLibre/Mapbox default. Lower is a flatter, more direct move; higher pulls
 * further out before coming back down, which is the "zoom out to show where
 * we're going" shot.
 */
export const ARC = { min: 0.8, max: 3, default: 1.42 } as const;

export function clampArc(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return ARC.default;
  return Math.min(ARC.max, Math.max(ARC.min, v));
}

export type BearingMode = 'fixed' | 'travel';

export const BEARING_MODES: readonly { id: BearingMode; label: string; hint: string }[] = [
  { id: 'fixed', label: 'Fixed', hint: 'North stays up (or wherever you rotate it)' },
  { id: 'travel', label: 'Follow route', hint: 'The map turns so you always travel upward' },
];

export function isBearingMode(v: unknown): v is BearingMode {
  return v === 'fixed' || v === 'travel';
}

/**
 * Bearing for each stop when the camera follows the route.
 *
 * Index i is the heading the camera holds while ARRIVING at stop i, i.e. the
 * heading of the leg that got there; stop 0 borrows the first leg's heading so
 * the opening shot is already oriented for the journey rather than snapping
 * round the moment it starts.
 */
export function travelBearings(stops: readonly { coordinate: LngLat }[]): number[] {
  if (stops.length < 2) return stops.map(() => 0);
  const headings = stops
    .slice(1)
    .map((s, i) => bearingBetween(stops[i]!.coordinate, s.coordinate));
  return stops.map((_, i) => (i === 0 ? headings[0]! : headings[i - 1]!));
}

/** Orbit is a rotation applied across a stop's dwell. Keep it sane. */
export const MAX_ORBIT_DEG = 180;

export function clampOrbit(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.min(MAX_ORBIT_DEG, Math.max(-MAX_ORBIT_DEG, Math.round(v)));
}
