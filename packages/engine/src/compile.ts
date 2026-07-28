import type {
  CameraKeyframe,
  LngLat,
  Project,
  ProjectFormat,
} from './types';
import { greatCircleArc, distanceMeters } from './geo';
import { simplifyLine } from './simplify';

export interface TripStop {
  name: string;
  coordinate: LngLat;
}

/**
 * How a leg between two stops is drawn.
 *  - 'flight': great-circle arc, computed locally. Always available.
 *  - 'drive':  real road geometry from a routing service. Falls back to
 *              'flight' whenever geometry is missing, so a routing outage
 *              degrades the look rather than breaking the animation.
 */
export type LegMode = 'flight' | 'drive';

export interface TripOptions {
  format?: Partial<ProjectFormat>;
  /** Zoom used when hovering over a stop. */
  stopZoom?: number;
  /** How long the camera dwells on each stop, ms. */
  dwellMs?: number;
  /** Base travel time per leg, ms (scaled a bit by distance). */
  legMs?: number;
  routeColor?: string;
  /** Per-leg mode; index i describes stops[i] -> stops[i+1]. */
  legModes?: readonly LegMode[];
  /**
   * Resolved road geometry per leg, when a router has supplied it.
   * `null`/absent means "not available" and the leg falls back to an arc.
   */
  legGeometries?: readonly (readonly LngLat[] | null | undefined)[];
  /** Simplification tolerance in degrees for supplied geometry. */
  simplifyTolerance?: number;
}

/**
 * Quick-mode compiler: an ordered list of stops becomes a full Project with
 * camera keyframes, animated routes, and pop-in markers.
 * Studio mode (later) edits the compiled tracks directly.
 */
export function compileTrip(
  name: string,
  stops: TripStop[],
  opts: TripOptions = {},
): Project {
  if (stops.length < 2) throw new Error('compileTrip needs at least 2 stops');

  const stopZoom = opts.stopZoom ?? 5.2;
  const dwellMs = opts.dwellMs ?? 1400;
  const baseLegMs = opts.legMs ?? 2600;

  const camera: CameraKeyframe[] = [];
  const routes: Project['routes'] = [];
  const markers: Project['markers'] = [];

  let t = 0;

  // Opening: camera on first stop, marker pops immediately.
  const first = stops[0]!;
  camera.push({ tMs: 0, camera: cam(first.coordinate, stopZoom) });
  markers.push(marker(0, first, 200));
  t += dwellMs;

  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]!;
    const to = stops[i]!;
    const legIndex = i - 1;

    const supplied = opts.legGeometries?.[legIndex];
    const wantsDrive = opts.legModes?.[legIndex] === 'drive';
    const coordinates =
      wantsDrive && supplied && supplied.length >= 2
        ? simplifyLine(supplied, opts.simplifyTolerance)
        : greatCircleArc(from.coordinate, to.coordinate, 96);

    // Longer legs get a bit more time (log-scaled, clamped).
    const km = distanceMeters(from.coordinate, to.coordinate) / 1000;
    const legMs = Math.round(
      baseLegMs * Math.min(1.8, Math.max(0.8, Math.log10(km + 10) / 3 + 0.55)),
    );

    camera.push({ tMs: t, camera: cam(from.coordinate, stopZoom), easing: 'easeInOutCubic' });

    routes.push({
      id: `route-${i}`,
      coordinates: coordinates as LngLat[],
      startMs: t,
      endMs: t + legMs,
      easing: 'easeInOutSine',
      color: opts.routeColor ?? '#e8590c',
      widthPx: 4,
    });

    t += legMs;
    camera.push({ tMs: t, camera: cam(to.coordinate, stopZoom), easing: 'easeInOutCubic' });
    markers.push(marker(i, to, t - 150));
    t += dwellMs;
  }

  const format: ProjectFormat = {
    width: 1920,
    height: 1080,
    fps: 30,
    ...opts.format,
    durationMs: opts.format?.durationMs ?? t + 400,
  };

  return { version: 1, name, format, camera, routes, markers };
}

function cam(center: LngLat, zoom: number) {
  return { center: [...center] as LngLat, zoom, bearing: 0, pitch: 0 };
}

function marker(i: number, stop: TripStop, enterMs: number) {
  return {
    id: `marker-${i}`,
    coordinate: [...stop.coordinate] as LngLat,
    label: stop.name,
    enterMs,
    enterDurationMs: 450,
  };
}
