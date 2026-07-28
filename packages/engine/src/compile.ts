import type {
  CameraKeyframe,
  LngLat,
  Project,
  ProjectFormat,
} from './types';
import { greatCircleArc, distanceMeters } from './geo';

export interface TripStop {
  name: string;
  coordinate: LngLat;
}

export interface TripOptions {
  format?: Partial<ProjectFormat>;
  /** Zoom used when hovering over a stop. */
  stopZoom?: number;
  /** How long the camera dwells on each stop, ms. */
  dwellMs?: number;
  /** Base travel time per leg, ms (scaled a bit by distance). */
  legMs?: number;
  routeColor?: string;
}

/**
 * Quick-mode compiler: an ordered list of stops becomes a full Project with
 * camera keyframes, animated great-circle routes, and pop-in markers.
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

    // Longer legs get a bit more time (log-scaled, clamped).
    const km = distanceMeters(from.coordinate, to.coordinate) / 1000;
    const legMs = Math.round(baseLegMs * Math.min(1.8, Math.max(0.8, Math.log10(km + 10) / 3 + 0.55)));

    camera.push({ tMs: t, camera: cam(from.coordinate, stopZoom), easing: 'easeInOutCubic' });

    routes.push({
      id: `route-${i}`,
      coordinates: greatCircleArc(from.coordinate, to.coordinate, 96),
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
