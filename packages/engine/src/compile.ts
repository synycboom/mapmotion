import type {
  CameraKeyframe,
  EasingId,
  LngLat,
  Project,
  ProjectFormat,
} from './types';
import { greatCircleArc, distanceMeters } from './geo';
import {
  autoStopZooms,
  clampArc,
  clampOrbit,
  clampZoom,
  travelBearings,
  zoomPreset,
  type BearingMode,
} from './framing';
import { simplifyLine } from './simplify';
import { buildTitleCards } from './title';
import { resolvePin, type PinAppearance } from './pins';
import {
  DEFAULT_REGION,
  resolveRegionSelection,
  type RegionTrack,
} from './regions';
import {
  migrateLegacyMode,
  travelMode,
  usesSuppliedGeometry,
  type TravelMode,
} from './travel';

export interface TripStop {
  name: string;
  coordinate: LngLat;
}

/**
 * How a leg between two stops is travelled. See travel.ts for the full set.
 * `LegMode` is kept as an alias because saved projects and shared URLs refer
 * to it; legacy values ('flight' | 'drive' | 'track') migrate on read.
 */
export type LegMode = TravelMode;

export interface TripOptions {
  format?: Partial<ProjectFormat>;
  /**
   * Zoom used when hovering over a stop. Ignored when `zoomPreset` is set.
   * Kept for saved projects and for callers that want one explicit number.
   */
  stopZoom?: number;
  /**
   * Named framing: a preset id from ZOOM_PRESETS, or 'auto' to derive each
   * stop's zoom from how far its nearest neighbour is.
   */
  zoomPreset?: string;
  /** Per-stop zoom override; `null`/absent falls back to the preset. */
  stopZooms?: readonly (number | null | undefined)[];
  /** Camera tilt in degrees applied to every keyframe (0 = straight down). */
  pitch?: number;
  /** Per-stop tilt override. */
  stopPitches?: readonly (number | null | undefined)[];
  /** Camera rotation in degrees applied to every keyframe. */
  bearing?: number;
  /** Per-stop rotation override; wins over `bearingMode`. */
  stopBearings?: readonly (number | null | undefined)[];
  /**
   * 'fixed' keeps `bearing` throughout; 'travel' turns the map so the
   * direction of travel points up the screen, rotating during each dwell.
   */
  bearingMode?: BearingMode;
  /**
   * van Wijk rho — how high the camera arcs on every travel leg. 1.42 is the
   * MapLibre default; higher pulls further out before coming back down.
   */
  arc?: number;
  /** Degrees the camera rotates around each stop during its dwell. */
  orbitDeg?: number;
  /** Per-stop orbit override. */
  stopOrbits?: readonly (number | null | undefined)[];
  /** Easing for every travel leg. */
  travelEasing?: EasingId;
  /** Per-leg easing override. */
  legEasings?: readonly (EasingId | null | undefined)[];
  /** How long the camera dwells on each stop, ms. */
  dwellMs?: number;
  /** Base travel time per leg, ms (scaled a bit by distance). */
  legMs?: number;
  routeColor?: string;
  /** Per-leg mode; index i describes stops[i] -> stops[i+1]. */
  legModes?: readonly (LegMode | string)[];
  /** Per-leg vehicle colour; falls back to the route colour. */
  legColors?: readonly (string | null | undefined)[];
  /** Draw a vehicle riding along each leg. Default true. */
  showVehicles?: boolean;
  /** Router-reported distance/duration per leg, for on-screen labels. */
  legDistances?: readonly (number | null | undefined)[];
  legDurations2?: readonly (number | null | undefined)[];
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
  /** Default marker appearance for every stop. */
  pin?: Partial<PinAppearance>;
  /** Per-stop marker overrides, indexed like `stops`. */
  pinOverrides?: readonly (Partial<PinAppearance> | null | undefined)[];
  /** Intro/outro card text. Omit or leave blank for no titles. */
  title?: string | null;
  subtitle?: string | null;
  /** Repeat the title as an end card. */
  outro?: boolean;
  /**
   * Highlighted country sets. Each entry is a list of alpha-3 codes and/or
   * REGION_GROUPS ids; groups are expanded and duplicates dropped.
   */
  regions?: readonly {
    selection: readonly string[];
    groupId?: string;
    label?: string;
    fillColor?: string;
    fillOpacity?: number;
    lineColor?: string;
    lineWidth?: number;
    /** Fraction of the video at which the fill appears. Default 0. */
    enterAt?: number;
  }[];
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

  // MapLibre rejects pitch above 85; clamp rather than let a bad saved
  // project throw on load.
  const pitch = Math.min(85, Math.max(0, opts.pitch ?? 0));
  const bearing = norm360(opts.bearing ?? 0);
  const dwellMs = opts.dwellMs ?? 1400;
  const baseLegMs = opts.legMs ?? 2600;
  const arc = clampArc(opts.arc);
  const bearingMode: BearingMode = opts.bearingMode ?? 'fixed';

  // ---- framing ----
  // Framing is decided against the SHORTER output axis, so a 9:16 vertical
  // and a 16:9 landscape frame the same trip comparably instead of the
  // vertical one cropping the journey away.
  const outW = opts.format?.width ?? 1920;
  const outH = opts.format?.height ?? 1080;
  const viewportPx = Math.min(outW, outH);

  const preset = opts.zoomPreset ? zoomPreset(opts.zoomPreset) : null;
  const autoZooms = autoStopZooms(stops, viewportPx);
  /** Zoom the camera holds at stop i, before per-stop overrides. */
  const baseZooms: number[] = preset
    ? preset.zoom === null
      ? autoZooms
      : stops.map(() => clampZoom(preset.zoom!))
    : stops.map(() => clampZoom(opts.stopZoom ?? 5.2));

  const zoomFor = (i: number) => {
    const override = opts.stopZooms?.[i];
    return override === null || override === undefined || !Number.isFinite(override)
      ? baseZooms[i]!
      : clampZoom(override);
  };

  const pitchFor = (i: number) => {
    const override = opts.stopPitches?.[i];
    return override === null || override === undefined || !Number.isFinite(override)
      ? pitch
      : Math.min(85, Math.max(0, override));
  };

  const orbitFor = (i: number) => {
    const override = opts.stopOrbits?.[i];
    return clampOrbit(
      override === null || override === undefined ? opts.orbitDeg : override,
    );
  };

  // Heading of the leg arriving at each stop; index 0 borrows leg 0 so the
  // opening shot is already oriented for the journey.
  const routeBearings = travelBearings(stops);
  /**
   * `kind` matters only in 'travel' mode: the camera arrives facing the leg
   * it just flew and leaves facing the next one, so the turn happens during
   * the dwell rather than mid-flight (which reads as the map spinning).
   */
  const bearingFor = (i: number, kind: 'arrive' | 'depart') => {
    const override = opts.stopBearings?.[i];
    if (override !== null && override !== undefined && Number.isFinite(override)) {
      return norm360(override);
    }
    if (bearingMode !== 'travel') return bearing;
    const idx = kind === 'depart' ? Math.min(i + 1, routeBearings.length - 1) : i;
    return norm360(routeBearings[idx]! + bearing);
  };

  // 'glide' rather than 'easeInOutCubic': the default has to work in a chain.
  // An explicit per-leg or per-project choice still wins, because someone who
  // asks for a hard ease-in-out on one leg means it.
  const easingFor = (legIndex: number): EasingId =>
    opts.legEasings?.[legIndex] ?? opts.travelEasing ?? 'glide';

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
  camera.push({
    tMs: 0,
    camera: cam(first.coordinate, zoomFor(0), bearingFor(0, 'arrive'), pitchFor(0)),
  });
  markers.push(marker(0, first, 200, resolvePin(opts.pin, opts.pinOverrides?.[0] ?? undefined)));
  t += dwellFor(0);

  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]!;
    const to = stops[i]!;
    const legIndex = i - 1;

    const supplied = opts.legGeometries?.[legIndex];
    const mode = migrateLegacyMode(opts.legModes?.[legIndex] as string | undefined);
    const spec = travelMode(mode);

    let coordinates: LngLat[];
    if (usesSuppliedGeometry(mode) && supplied && supplied.length >= 2) {
      coordinates = simplifyLine(supplied, opts.simplifyTolerance);
    } else if (spec.path === 'straight') {
      coordinates = [[...from.coordinate], [...to.coordinate]];
    } else {
      // Arc is the fallback for every mode: a router outage or a missing
      // import degrades the look, never the animation.
      coordinates = greatCircleArc(from.coordinate, to.coordinate, 96);
    }

    // Longer legs get a bit more time (log-scaled, clamped) unless the user
    // has retimed this segment in Studio mode.
    const km = distanceMeters(from.coordinate, to.coordinate) / 1000;
    const derived = Math.round(
      baseLegMs * Math.min(1.8, Math.max(0.8, Math.log10(km + 10) / 3 + 0.55)),
    );
    const legMs = clampDuration(opts.legDurations?.[legIndex], derived);

    // Departure keyframe. The segment ENDING here is stop (i-1)'s dwell, so
    // this is where an orbit or a turn-to-face-the-next-leg lands.
    camera.push({
      tMs: t,
      camera: cam(
        from.coordinate,
        zoomFor(i - 1),
        bearingFor(i - 1, 'depart') + orbitFor(i - 1),
        pitchFor(i - 1),
      ),
      // A dwell is a rotation in place. 'glide' hands the orbit's speed
      // straight over to the departing leg instead of parking the camera at
      // the junction, which is where the stutter used to live.
      easing: 'glide',
    });

    const color = opts.legColors?.[legIndex] ?? opts.routeColor ?? '#e8590c';
    routes.push({
      id: `route-${i}`,
      coordinates,
      mode,
      startMs: t,
      endMs: t + legMs,
      easing: 'easeInOutSine',
      color,
      widthPx: 4,
      distanceMeters: opts.legDistances?.[legIndex] ?? undefined,
      durationSeconds: opts.legDurations2?.[legIndex] ?? undefined,
      vehicle:
        opts.showVehicles === false || spec.icon === 'dot'
          ? undefined
          : { icon: spec.icon, color, size: 1 },
    });

    t += legMs;
    camera.push({
      tMs: t,
      camera: cam(to.coordinate, zoomFor(i), bearingFor(i, 'arrive'), pitchFor(i)),
      easing: easingFor(legIndex),
      rho: arc,
    });
    markers.push(marker(i, to, t - 150, resolvePin(opts.pin, opts.pinOverrides?.[i] ?? undefined)));
    t += dwellFor(i);
  }

  // Closing keyframe so the last stop has a dwell to orbit through. Without
  // it cameraAt just holds the arrival frame and the final stop is the only
  // one that never moves.
  const lastIndex = stops.length - 1;
  camera.push({
    tMs: t,
    camera: cam(
      stops[lastIndex]!.coordinate,
      zoomFor(lastIndex),
      bearingFor(lastIndex, 'arrive') + orbitFor(lastIndex),
      pitchFor(lastIndex),
    ),
    // Also 'glide' — being the last keyframe, it resolves to a full stop, so
    // the video still comes to rest rather than being cut off mid-orbit.
    easing: 'glide',
  });

  const format: ProjectFormat = {
    width: 1920,
    height: 1080,
    fps: 30,
    ...opts.format,
    durationMs: opts.format?.durationMs ?? t + 400,
  };

  // Regions are timed as a fraction of the whole video rather than in ms,
  // because the video's length isn't known until every leg has been laid out
  // — and a highlight is almost always "from the start" or "when we get
  // there", not "at 4,200ms".
  const totalMs = opts.format?.durationMs ?? t + 400;
  const regions: RegionTrack[] = (opts.regions ?? []).map((r, i) => ({
    id: `region-${i}`,
    codes: resolveRegionSelection(r.selection),
    groupId: r.groupId,
    label: r.label,
    fillColor: r.fillColor ?? DEFAULT_REGION.fillColor,
    fillOpacity: clamp01(r.fillOpacity ?? DEFAULT_REGION.fillOpacity),
    lineColor: r.lineColor ?? DEFAULT_REGION.lineColor,
    lineWidth: Math.max(0, r.lineWidth ?? DEFAULT_REGION.lineWidth),
    enterMs: Math.round(clamp01(r.enterAt ?? 0) * totalMs),
    enterDurationMs: DEFAULT_REGION.enterDurationMs,
  })).filter((r) => r.codes.length > 0);

  const titles = buildTitleCards({
    title: opts.title,
    subtitle: opts.subtitle,
    durationMs: format.durationMs,
    outro: opts.outro ?? false,
  });

  return { version: 1, name, format, camera, routes, markers, regions, titles };
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

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function norm360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

function cam(center: LngLat, zoom: number, bearing = 0, pitch = 0) {
  // Bearings are summed from several sources (mode, override, orbit), so
  // normalise here rather than at every call site. Orbit is deliberately
  // applied BEFORE this, so a +180 orbit survives as a real half-turn:
  // lerpBearing takes the shortest path between the two normalised
  // endpoints, which is what "orbit halfway round" should look like.
  return { center: [...center] as LngLat, zoom, bearing: norm360(bearing), pitch };
}

function marker(
  i: number,
  stop: TripStop,
  enterMs: number,
  pin: PinAppearance,
) {
  return {
    id: `marker-${i}`,
    coordinate: [...stop.coordinate] as LngLat,
    label: stop.name,
    pin,
    enterMs,
    enterDurationMs: 450,
  };
}

/**
 * The video's timeline as a flat list of segments, read back from the
 * compiled camera track.
 *
 * Derived rather than remembered: the compiler already resolved every
 * override, speed multiplier and clamp, so reading the keyframes back is the
 * only way to get the durations that actually rendered. Recomputing them from
 * the options would drift the moment either side changes.
 *
 * Keyframes alternate arrive/depart per stop, so the diffs alternate
 * dwell, leg, dwell, ... and there are always n dwells and n-1 legs.
 */
export function tripSegments(project: Project): { dwells: number[]; legs: number[] } {
  const kfs = project.camera;
  const dwells: number[] = [];
  const legs: number[] = [];
  for (let i = 1; i < kfs.length; i++) {
    const span = kfs[i]!.tMs - kfs[i - 1]!.tMs;
    if ((i - 1) % 2 === 0) dwells.push(span);
    else legs.push(span);
  }
  return { dwells, legs };
}
