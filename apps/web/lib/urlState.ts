import type { LegMode, TripStop } from '@mapmotion/engine';

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

export interface UrlState {
  stops: TripStop[];
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
  // Legs encode as a compact flag string, one char per leg: f=flight, d=drive.
  if (s.legModes.some((m) => m === 'drive')) {
    params.set('l', s.legModes.map((m) => (m === 'drive' ? 'd' : 'f')).join(''));
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
    (_, i) => (legRaw[i] === 'd' ? 'drive' : 'flight'),
  );

  const f = p.get('f');
  const format: FormatId =
    f && f in FORMATS ? (f as FormatId) : fallback.format;

  const spd = Number(p.get('spd'));
  const speed = Number.isFinite(spd) && spd > 0.2 && spd <= 4 ? spd : fallback.speed;

  const r = Number(p.get('res'));
  const res = Number.isFinite(r) && r >= 0.25 && r <= 1 ? r : fallback.res;

  return {
    stops,
    legModes,
    format,
    styleId: p.get('style') ?? fallback.styleId,
    speed,
    res,
  };
}
