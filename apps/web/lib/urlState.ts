import {
  ARC,
  clampArc,
  clampOrbit,
  clampZoom,
  codeToMode,
  isBearingMode,
  modeToCode,
  zoomPreset,
  type BearingMode,
  type EasingId,
  type LegMode,
  type TripStop,
} from '@mapmotion/engine';

/**
 * Project state <-> URL. Lets a map be linked, bookmarked and reloaded with
 * no backend at all — persistence before we have a database, and shareable
 * links for free.
 *
 * Kept human-readable rather than base64 so links are debuggable and
 * hand-editable: ?s=Bangkok,100.5,13.75~Tokyo,139.69,35.69&f=9x16
 */

export const FORMATS = {
  '16x9': { width: 1280, height: 720, label: '16:9 · landscape' },
  '9x16': { width: 720, height: 1280, label: '9:16 · vertical' },
  '1x1': { width: 1080, height: 1080, label: '1:1 · square' },
} as const;

export type FormatId = keyof typeof FORMATS;

export interface MapAppearance {
  /** Per-category label visibility. */
  labels: { places: boolean; countries: boolean; roads: boolean; water: boolean; pois: boolean };
  projection: 'mercator' | 'globe';
  terrain: boolean;
  pitch: number;
}

export const DEFAULT_APPEARANCE: MapAppearance = {
  labels: { places: true, countries: true, roads: true, water: true, pois: true },
  projection: 'mercator',
  terrain: false,
  pitch: 0,
};

const LABEL_ORDER = ['places', 'countries', 'roads', 'water', 'pois'] as const;

/** Easings offered in the UI, in the order they're shown. */
export const EASING_CHOICES: readonly { id: EasingId; label: string }[] = [
  { id: 'easeInOutCubic', label: 'Smooth' },
  { id: 'easeInOutSine', label: 'Gentle' },
  { id: 'easeOutCubic', label: 'Snap out' },
  { id: 'easeInCubic', label: 'Ramp up' },
  { id: 'linear', label: 'Constant' },
];

const EASING_CODES: Record<EasingId, string> = {
  easeInOutCubic: 'c',
  easeInOutSine: 's',
  easeOutCubic: 'o',
  easeInCubic: 'i',
  linear: 'l',
};

function easingFromCode(code: string | null): EasingId | null {
  const hit = (Object.keys(EASING_CODES) as EasingId[]).find(
    (k) => EASING_CODES[k] === code,
  );
  return hit ?? null;
}

/** How the camera frames, moves and turns. */
export interface CameraSettings {
  /** A ZOOM_PRESETS id, or 'auto' to derive framing from the trip. */
  zoomPreset: string;
  /** van Wijk rho — how high the camera arcs between stops. */
  arc: number;
  bearingMode: BearingMode;
  /** Rotation in degrees; an offset on top of the heading in 'travel' mode. */
  bearing: number;
  /** Degrees the camera turns around each stop during its dwell. */
  orbit: number;
  easing: EasingId;
  /** Per-stop zoom override, parallel to stops. `null` = use the preset. */
  stopZooms: (number | null)[];
}

export const DEFAULT_CAMERA: CameraSettings = {
  zoomPreset: 'auto',
  arc: ARC.default,
  bearingMode: 'fixed',
  bearing: 0,
  orbit: 0,
  easing: 'easeInOutCubic',
  stopZooms: [],
};

const STOP_ZOOM_SEP = '_';
const STOP_ZOOM_AUTO = '-';

export interface UrlState {
  stops: TripStop[];
  appearance: MapAppearance;
  camera: CameraSettings;
  /** Per-leg travel mode; length is stops.length - 1. */
  legModes: LegMode[];
  format: FormatId;
  styleId: string;
  speed: number;
  /**
   * Output resolution multiplier (0.25–1). 1 is full quality; lower values
   * render a faster draft. Also what CI uses to keep software-GL renders
   * quick.
   */
  res: number;
}

/** Even dimensions — H.264 requires them, and odd sizes break some encoders. */
export function scaledDims(
  format: FormatId,
  res: number,
): { width: number; height: number } {
  const f = FORMATS[format];
  const even = (n: number) => Math.max(2, Math.round((n * res) / 2) * 2);
  return { width: even(f.width), height: even(f.height) };
}

const STOP_SEP = '~';
const FIELD_SEP = ',';

export function encodeState(s: UrlState): string {
  const params = new URLSearchParams();
  if (s.stops.length) {
    params.set(
      's',
      s.stops
        .map((st) =>
          [
            st.name.replace(/[~,]/g, ' '),
            st.coordinate[0].toFixed(4),
            st.coordinate[1].toFixed(4),
          ].join(FIELD_SEP),
        )
        .join(STOP_SEP),
    );
  }
  // Legs encode as one character each (see travel.ts for the code map).
  // Imported-track *geometry* is far too big for a URL, so a 't' leg
  // reloaded from a link arcs until re-imported.
  if (s.legModes.some((m) => m !== 'air')) {
    params.set('l', s.legModes.map(modeToCode).join(''));
  }
  // Appearance packs into short params so links stay readable.
  const a = s.appearance;
  const labelBits = LABEL_ORDER.map((k) => (a.labels[k] ? '1' : '0')).join('');
  if (labelBits !== '11111') params.set('lb', labelBits);
  if (a.projection !== 'mercator') params.set('prj', a.projection);
  if (a.terrain) params.set('ter', '1');
  if (a.pitch !== 0) params.set('pit', String(Math.round(a.pitch)));

  // Camera. Every one of these is omitted at its default so a plain trip link
  // stays short and readable.
  const c = s.camera;
  if (c.zoomPreset !== DEFAULT_CAMERA.zoomPreset) params.set('zm', c.zoomPreset);
  if (Math.abs(c.arc - DEFAULT_CAMERA.arc) > 1e-6) params.set('arc', c.arc.toFixed(2));
  if (c.bearingMode !== 'fixed') params.set('bm', c.bearingMode);
  if (c.bearing !== 0) params.set('brg', String(Math.round(c.bearing)));
  if (c.orbit !== 0) params.set('orb', String(Math.round(c.orbit)));
  if (c.easing !== DEFAULT_CAMERA.easing) params.set('ez', EASING_CODES[c.easing]);
  // Per-stop zooms are only worth the URL bytes when at least one is set.
  const zooms = c.stopZooms.slice(0, s.stops.length);
  if (zooms.some((z) => z !== null && z !== undefined)) {
    params.set(
      'sz',
      Array.from({ length: s.stops.length }, (_, i) => {
        const z = zooms[i];
        return z === null || z === undefined ? STOP_ZOOM_AUTO : z.toFixed(1);
      }).join(STOP_ZOOM_SEP),
    );
  }

  params.set('f', s.format);
  params.set('style', s.styleId);
  if (s.speed !== 1) params.set('spd', String(s.speed));
  if (s.res !== 1) params.set('res', String(s.res));
  return params.toString();
}

export function decodeState(
  search: string,
  fallback: UrlState,
): UrlState {
  const p = new URLSearchParams(search);

  const raw = p.get('s');
  let stops = fallback.stops;
  if (raw) {
    const parsed = raw
      .split(STOP_SEP)
      .map((chunk) => {
        const parts = chunk.split(FIELD_SEP);
        if (parts.length < 3) return null;
        const lng = Number(parts[parts.length - 2]);
        const lat = Number(parts[parts.length - 1]);
        const name = parts.slice(0, -2).join(FIELD_SEP).trim();
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        if (lng < -180 || lng > 180 || lat < -85 || lat > 85) return null;
        return { name: name || 'Stop', coordinate: [lng, lat] as [number, number] };
      })
      .filter((x): x is TripStop => x !== null);
    if (parsed.length) stops = parsed;
  }

  const legRaw = p.get('l') ?? '';
  const legModes: LegMode[] = Array.from(
    { length: Math.max(0, stops.length - 1) },
    (_, i) => codeToMode(legRaw[i]),
  );

  const bits = p.get('lb') ?? '';
  const labels = { ...DEFAULT_APPEARANCE.labels };
  if (/^[01]{5}$/.test(bits)) {
    LABEL_ORDER.forEach((k, i) => {
      labels[k] = bits[i] === '1';
    });
  }
  const pitchRaw = Number(p.get('pit'));
  const appearance: MapAppearance = {
    labels,
    projection: p.get('prj') === 'globe' ? 'globe' : 'mercator',
    terrain: p.get('ter') === '1',
    pitch:
      Number.isFinite(pitchRaw) && pitchRaw >= 0 && pitchRaw <= 85
        ? pitchRaw
        : fallback.appearance?.pitch ?? 0,
  };

  // ---- camera ----
  // Everything here comes from a URL a stranger can edit, so each field is
  // validated or clamped and falls back to the default rather than reaching
  // MapLibre as NaN.
  const presetParam = p.get('zm');
  const bearingRaw = Number(p.get('brg'));
  const orbitRaw = Number(p.get('orb'));
  const arcRaw = Number(p.get('arc'));
  const bmRaw = p.get('bm');
  const base = fallback.camera ?? DEFAULT_CAMERA;

  const szRaw = p.get('sz');
  const stopZooms: (number | null)[] = szRaw
    ? szRaw.split(STOP_ZOOM_SEP).map((chunk) => {
        if (chunk === STOP_ZOOM_AUTO || chunk === '') return null;
        const n = Number(chunk);
        return Number.isFinite(n) ? clampZoom(n) : null;
      })
    : base.stopZooms;

  const camera: CameraSettings = {
    // An unknown preset id resolves to 'auto' rather than silently framing
    // everything at zoom 5.
    zoomPreset: presetParam ? zoomPreset(presetParam).id : base.zoomPreset,
    arc: p.has('arc') ? clampArc(arcRaw) : base.arc,
    bearingMode: isBearingMode(bmRaw) ? (bmRaw as BearingMode) : base.bearingMode,
    bearing: Number.isFinite(bearingRaw) ? ((bearingRaw % 360) + 360) % 360 : base.bearing,
    orbit: p.has('orb') ? clampOrbit(orbitRaw) : base.orbit,
    easing: easingFromCode(p.get('ez')) ?? base.easing,
    stopZooms,
  };

  const f = p.get('f');
  const format: FormatId =
    f && f in FORMATS ? (f as FormatId) : fallback.format;

  const spd = Number(p.get('spd'));
  const speed = Number.isFinite(spd) && spd > 0.2 && spd <= 4 ? spd : fallback.speed;

  const r = Number(p.get('res'));
  const res = Number.isFinite(r) && r >= 0.25 && r <= 1 ? r : fallback.res;

  return {
    stops,
    appearance,
    camera,
    legModes,
    format,
    styleId: p.get('style') ?? fallback.styleId,
    speed,
    res,
  };
}
