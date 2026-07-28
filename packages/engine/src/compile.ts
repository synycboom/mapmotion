import type {
  CameraKeyframe,
  LngLat,
  Project,
  ProjectFormat,
} from './types';
import { greatCircleArc, distanceMeters } from './geo';
import { simplifyLine } from './simplify';
import { buildTitleCards } from './title';

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
 *  - 'track':  geometry from an imported GPX/KML file.
 *
 * 'drive' and 'track' both animate supplied geometry; they differ only in
 * where it came from, which matters for the UI and for whether we re-fetch.
 */
export type LegMode = 'flight' | 'drive' | 'track';

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
  /**
   * Per-leg travel duration in ms, index i = stops[i] -> stops[i+1].
   * `null`/absent means "derive it from distance" (Quick mode). Studio mode
   * sets these when the user retimes a segment.
   */
  legDurations?: readonly (number | null | undefined)[];
  /** Per-stop dwell in ms; `null`/absent uses the global dwellMs. */
  stopDwells?: readonly (number | null | undefined)[];
  /** Intro/outro card text. Omit or leave blank for no titles. */
  title?: string | null;
  subtitle?: string | null;
  /** Repeat the title as an end card. */
  outro?: boolean;
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

  const dwellFor = (i: number) => {
    const override = opts.stopDwells?.[i];
    return clampDuration(override, dwellMs);
  };

  // Opening: camera on first stop, marker pops immediately.
  const first = stops[0]!;
  camera.push({ tMs: 0, camera: cam(first.coordinate, stopZoom) });
  markers.push(marker(0, first, 200));
  t += dwellFor(0);

  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]!;
    const to = stops[i]!;
    const legIndex = i - 1;

    const supplied = opts.legGeometries?.[legIndex];
    const mode = opts.legModes?.[legIndex];
    const usesGeometry = mode === 'drive' || mode === 'track';
    const coordinates =
      usesGeometry && supplied && supplied.length >= 2
        ? simplifyLine(supplied, opts.simplifyTolerance)
        : greatCircleArc(from.coordinate, to.coordinate, 96);

    // Longer legs get a bit more time (log-scaled, clamped) unless the user
    // has retimed this segment in Studio mode.
    const km = distanceMeters(from.coordinate, to.coordinate) / 1000;
    const derived = Math.round(
      baseLegMs * Math.min(1.8, Math.max(0.8, Math.log10(km + 10) / 3 + 0.55)),
    );
    const legMs = clampDuration(opts.legDurations?.[legIndex], derived);

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
    t += dwellFor(i);
  }

  const format: ProjectFormat = {
    width: 1920,
    height: 1080,
    fps: 30,
    ...opts.format,
    durationMs: opts.format?.durationMs ?? t + 400,
  };

  const titles = buildTitleCards({
    title: opts.title,
    subtitle: opts.subtitle,
    durationMs: format.durationMs,
    outro: opts.outro ?? false,
  });

  return { version: 1, name, format, camera, routes, markers, titles };
}

/**
 * Durations come from user input and from persisted projects, so they can be
 * NaN, negative, or absurd. Clamp to a sane window rather than letting a bad
 * value produce a zero-length or hour-long segment.
 */
const MIN_SEGMENT_MS = 200;
const MAX_SEGMENT_MS = 60_000;

function clampDuration(
  value: number | null | undefined,
  fallback: number,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.round(Math.min(MAX_SEGMENT_MS, Math.max(MIN_SEGMENT_MS, value)));
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
