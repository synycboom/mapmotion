/**
 * Marker (pin) styling.
 *
 * Every stop currently renders as the same dot, which is the single biggest
 * "this looks like a prototype" signal in an exported video. Mapimator
 * exposes six pin styles and it visibly matters.
 *
 * Style is a per-project default with optional per-marker override, because
 * the common case is "make them all pins" and the interesting case is "make
 * this one stop the landmark".
 */

export type PinStyle =
  | 'dot'
  | 'pin'
  | 'bubble'
  | 'marker'
  | 'emoji'
  | 'image'
  | 'none';

export interface PinStyleSpec {
  id: PinStyle;
  label: string;
  /** Does this style draw a text label beside the symbol by default? */
  labelByDefault: boolean;
  hint: string;
}

export const PIN_STYLES: readonly PinStyleSpec[] = [
  { id: 'dot', label: 'Dot', labelByDefault: true, hint: 'Minimal circle.' },
  { id: 'pin', label: 'Pin', labelByDefault: true, hint: 'Classic teardrop pin.' },
  {
    id: 'bubble',
    label: 'Bubble',
    labelByDefault: false,
    hint: 'Name inside a rounded badge — no separate label.',
  },
  { id: 'marker', label: 'Marker', labelByDefault: true, hint: 'Large prominent marker.' },
  { id: 'emoji', label: 'Emoji', labelByDefault: true, hint: 'Any emoji as the pin.' },
  { id: 'image', label: 'Image', labelByDefault: true, hint: 'Your own image as the pin.' },
  { id: 'none', label: 'Hidden', labelByDefault: false, hint: 'No marker at all.' },
];

const BY_ID = new Map(PIN_STYLES.map((s) => [s.id, s]));

export function pinStyle(id: PinStyle | string | undefined): PinStyleSpec {
  return BY_ID.get(id as PinStyle) ?? BY_ID.get('dot')!;
}

export interface PinAppearance {
  style: PinStyle;
  color: string;
  /** Multiplier on the base size. Clamped to a usable range. */
  size: number;
  showLabel: boolean;
  /** For 'emoji' style. */
  emoji?: string;
  /** For 'image' style — a data URL or absolute URL. */
  imageUrl?: string;
}

export const DEFAULT_PIN: PinAppearance = {
  style: 'dot',
  color: '#ffd43b',
  size: 1,
  showLabel: true,
};

const MIN_SIZE = 0.4;
const MAX_SIZE = 3;

/**
 * Resolve the appearance for one marker: project default, then per-marker
 * override, then whatever the style forces.
 */
export function resolvePin(
  base: Partial<PinAppearance> | undefined,
  override: Partial<PinAppearance> | undefined,
): PinAppearance {
  const merged: PinAppearance = {
    ...DEFAULT_PIN,
    ...(base ?? {}),
    ...(override ?? {}),
  };

  const spec = pinStyle(merged.style);
  merged.style = spec.id;
  merged.size = Number.isFinite(merged.size)
    ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, merged.size))
    : 1;

  // A bubble already contains the name, so a second floating label would
  // just duplicate it. 'none' means nothing renders at all.
  if (spec.id === 'bubble' || spec.id === 'none') merged.showLabel = false;

  // Fall back rather than render an empty symbol when the style's required
  // content is missing.
  if (spec.id === 'emoji' && !merged.emoji?.trim()) merged.style = 'dot';
  if (spec.id === 'image' && !merged.imageUrl?.trim()) merged.style = 'dot';

  return merged;
}
