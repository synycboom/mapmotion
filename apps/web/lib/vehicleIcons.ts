import type { Map as MLMap } from 'maplibre-gl';

/**
 * Vehicle sprites, generated at runtime.
 *
 * Rather than shipping a sprite sheet, each icon is an inline SVG rasterised
 * into a MapLibre image on demand. That keeps them independent of whichever
 * basemap style is loaded (a style swap wipes the sprite, and OpenFreeMap's
 * sprite has no vehicles anyway) and lets us tint per leg without an SDF —
 * we just re-render the SVG in the requested colour and cache by
 * icon+colour.
 *
 * Every icon is drawn pointing NORTH, because MapLibre's `icon-rotate`
 * measures degrees clockwise from north — the same convention the engine's
 * `bearingBetween` returns.
 */

const SIZE = 64; // rasterised at 2x for crisp display at ~32px

type IconBuilder = (color: string) => string;

const stroke = (d: string, color: string, width = 6) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

const PIN_ICONS: Record<string, IconBuilder> = {
  // Drawn with the point at the BOTTOM of the viewbox so the sprite can be
  // bottom-anchored on its coordinate, the way a real map pin sits.
  pinshape: (c) => `
    <path d="M32 62 C32 62 54 36 54 24 A22 22 0 1 0 10 24 C10 36 32 62 32 62 Z"
      fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="32" cy="24" r="8" fill="rgba(255,255,255,0.9)"/>`,
  markershape: (c) => `
    <path d="M32 62 L20 34 A14 14 0 1 1 44 34 Z"
      fill="${c}" stroke="rgba(0,0,0,0.4)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="32" cy="24" r="10" fill="${c}" stroke="rgba(0,0,0,0.4)" stroke-width="2"/>
    <circle cx="32" cy="24" r="4.5" fill="rgba(255,255,255,0.95)"/>`,
};

const ICONS: Record<string, IconBuilder> = {
  ...PIN_ICONS,
  plane: (c) => `
    <path d="M32 4 L38 26 L60 36 L60 42 L38 37 L37 52 L44 57 L44 60 L32 57 L20 60 L20 57 L27 52 L26 37 L4 42 L4 36 L26 26 Z"
      fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="1.5" stroke-linejoin="round"/>`,
  car: (c) => `
    <rect x="18" y="8" width="28" height="48" rx="9"
      fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/>
    <path d="M23 20 L41 20 L38 13 L26 13 Z" fill="rgba(255,255,255,0.75)"/>
    <path d="M23 44 L41 44 L39 51 L25 51 Z" fill="rgba(255,255,255,0.45)"/>`,
  moto: (c) => `
    <circle cx="32" cy="16" r="8" fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/>
    <circle cx="32" cy="48" r="8" fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/>
    ${stroke('M32 24 L32 40', c, 7)}`,
  train: (c) => `
    <rect x="19" y="6" width="26" height="52" rx="7"
      fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/>
    <rect x="24" y="12" width="16" height="12" rx="3" fill="rgba(255,255,255,0.8)"/>
    <circle cx="26" cy="50" r="3" fill="rgba(255,255,255,0.6)"/>
    <circle cx="38" cy="50" r="3" fill="rgba(255,255,255,0.6)"/>`,
  ship: (c) => `
    <path d="M32 4 L44 30 L44 48 Q32 60 20 48 L20 30 Z"
      fill="${c}" stroke="rgba(0,0,0,0.35)" stroke-width="1.5" stroke-linejoin="round"/>
    <rect x="28" y="20" width="8" height="14" rx="2" fill="rgba(255,255,255,0.75)"/>`,
  bike: (c) => `
    <circle cx="18" cy="44" r="11" fill="none" stroke="${c}" stroke-width="5"/>
    <circle cx="46" cy="44" r="11" fill="none" stroke="${c}" stroke-width="5"/>
    ${stroke('M18 44 L30 26 L46 44 M30 26 L38 26', c, 5)}`,
  walk: (c) => `
    <circle cx="32" cy="12" r="7" fill="${c}"/>
    ${stroke('M32 20 L32 38 M32 38 L24 56 M32 38 L41 56 M32 26 L21 32 M32 26 L43 32', c, 6)}`,
  dot: (c) => `
    <circle cx="32" cy="32" r="13" fill="#ffffff" stroke="${c}" stroke-width="7"/>`,
};

export const VEHICLE_ICON_IDS = Object.keys(ICONS);

/** Stable image id for an icon+colour pair. */
export function vehicleImageId(icon: string, color: string): string {
  return `mm-veh-${icon}-${color.replace(/[^a-z0-9]/gi, '')}`;
}

function svgFor(icon: string, color: string): string {
  const build = ICONS[icon] ?? ICONS.dot!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64">${build(color)}</svg>`;
}

/**
 * Register one icon. Resolves once the image is available on the map, so
 * callers can await it and know a render will not miss the sprite — which
 * matters for export, where a late-arriving image would produce a frame
 * without the vehicle.
 */
async function registerIcon(
  map: MLMap,
  icon: string,
  color: string,
): Promise<void> {
  const id = vehicleImageId(icon, color);
  if (map.hasImage(id)) return;

  const svg = svgFor(icon, color);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const img = new Image(SIZE, SIZE);
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`icon ${icon} failed to rasterise`));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for vehicle icon');
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE);

  // A style swap can land between the await above and here.
  if (map.hasImage(id)) return;
  map.addImage(id, data, { pixelRatio: 2 });
}

/**
 * Ensure every icon+colour a project needs is on the map.
 * Failures are swallowed per icon: a missing sprite should cost you a
 * vehicle, not the whole render.
 */
export async function ensureVehicleIcons(
  map: MLMap,
  pairs: ReadonlyArray<{ icon: string; color: string }>,
): Promise<void> {
  const seen = new Set<string>();
  await Promise.all(
    pairs.map(async ({ icon, color }) => {
      const key = `${icon}|${color}`;
      if (seen.has(key)) return;
      seen.add(key);
      try {
        await registerIcon(map, icon, color);
      } catch {
        /* keep going — the layer falls back to no icon */
      }
    }),
  );
}
