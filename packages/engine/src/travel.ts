/**
 * Travel modes.
 *
 * A mode decides three separate things, and keeping them separate is what
 * makes the set cheap to extend:
 *   1. how the path geometry is produced (arc / road routing / imported file)
 *   2. which routing profile to ask for, if any
 *   3. what vehicle rides along it
 *
 * Rail and sea have no public routing engine we can use, so they draw a
 * great-circle arc — which is also what a viewer expects from a stylised
 * ferry or train line. Being explicit about that here beats silently
 * failing to route.
 */

export type TravelMode =
  | 'direct'
  | 'air'
  | 'car'
  | 'moto'
  | 'train'
  | 'sea'
  | 'bike'
  | 'walk'
  | 'file';

/** How the path between two stops is produced. */
export type PathKind = 'straight' | 'arc' | 'routed' | 'supplied';

/** OSRM profile names on the FOSSGIS community instance. */
export type RoutingProfile = 'car' | 'bike' | 'foot';

export interface TravelModeSpec {
  id: TravelMode;
  label: string;
  /** Icon id — resolved to a sprite by the renderer. */
  icon: string;
  path: PathKind;
  profile?: RoutingProfile;
  /** Emoji used in compact UI (mode pills). */
  glyph: string;
  hint: string;
}

export const TRAVEL_MODES: readonly TravelModeSpec[] = [
  {
    id: 'direct',
    label: 'Direct',
    icon: 'dot',
    path: 'straight',
    glyph: '↗',
    hint: 'Straight line between points.',
  },
  {
    id: 'air',
    label: 'Flight',
    icon: 'plane',
    path: 'arc',
    glyph: '✈',
    hint: 'Great-circle arc, like a flight path.',
  },
  {
    id: 'car',
    label: 'Car',
    icon: 'car',
    path: 'routed',
    profile: 'car',
    glyph: '🚗',
    hint: 'Follows real roads.',
  },
  {
    id: 'moto',
    label: 'Motorbike',
    icon: 'moto',
    path: 'routed',
    profile: 'car',
    glyph: '🏍',
    hint: 'Follows real roads.',
  },
  {
    id: 'train',
    label: 'Train',
    icon: 'train',
    path: 'arc',
    glyph: '🚆',
    hint: 'Stylised arc — no public rail routing engine.',
  },
  {
    id: 'sea',
    label: 'Ferry',
    icon: 'ship',
    path: 'arc',
    glyph: '⛴',
    hint: 'Stylised arc across water.',
  },
  {
    id: 'bike',
    label: 'Bike',
    icon: 'bike',
    path: 'routed',
    profile: 'bike',
    glyph: '🚲',
    hint: 'Follows cycle-friendly routes.',
  },
  {
    id: 'walk',
    label: 'Walk',
    icon: 'walk',
    path: 'routed',
    profile: 'foot',
    glyph: '🚶',
    hint: 'Follows footpaths.',
  },
  {
    id: 'file',
    label: 'Imported',
    icon: 'dot',
    path: 'supplied',
    glyph: '📍',
    hint: 'Uses geometry from an imported GPX/KML file.',
  },
];

const BY_ID = new Map(TRAVEL_MODES.map((m) => [m.id, m]));

export function travelMode(id: TravelMode | string | undefined): TravelModeSpec {
  return BY_ID.get(id as TravelMode) ?? BY_ID.get('air')!;
}

/** Does this mode need road geometry fetched from a router? */
export function needsRouting(id: TravelMode): boolean {
  return travelMode(id).path === 'routed';
}

/** Does this mode animate geometry supplied from elsewhere (router or file)? */
export function usesSuppliedGeometry(id: TravelMode): boolean {
  const kind = travelMode(id).path;
  return kind === 'routed' || kind === 'supplied';
}

// ---------------------------------------------------------------------------
// Back-compat with the original three-value model.
//
// Saved projects and shared URLs from before travel modes existed use
// 'flight' | 'drive' | 'track'. Migrating on read (rather than in a one-off
// data migration) keeps old links working forever, which matters because a
// shared link is the main way this product spreads.
// ---------------------------------------------------------------------------

const LEGACY: Record<string, TravelMode> = {
  flight: 'air',
  drive: 'car',
  track: 'file',
};

export function migrateLegacyMode(value: string | undefined): TravelMode {
  if (!value) return 'air';
  if (BY_ID.has(value as TravelMode)) return value as TravelMode;
  return LEGACY[value] ?? 'air';
}

/** Single-character codes for compact URL encoding. */
const URL_CODES: Record<TravelMode, string> = {
  direct: 'x',
  air: 'f',
  car: 'd',
  moto: 'm',
  train: 'r',
  sea: 's',
  bike: 'b',
  walk: 'w',
  file: 't',
};
const FROM_CODE = new Map(
  Object.entries(URL_CODES).map(([mode, code]) => [code, mode as TravelMode]),
);

export function modeToCode(mode: TravelMode): string {
  return URL_CODES[mode] ?? 'f';
}

export function codeToMode(code: string | undefined): TravelMode {
  return FROM_CODE.get(code ?? '') ?? 'air';
}
