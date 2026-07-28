import type { Map as MLMap } from 'maplibre-gl';

/**
 * Map appearance controls — label layers, projection, and terrain.
 *
 * These are the cheapest thing that makes an animated map look professional.
 * A clean map with only the labels you want beats a busy one with a nicer
 * basemap, and it's the difference between "screenshot of a map" and
 * "designed graphic". Mapimator exposes exactly this and it's one of the
 * better parts of their UI.
 */

export type LabelCategory = 'places' | 'countries' | 'roads' | 'water' | 'pois';

export interface LabelVisibility {
  places: boolean;
  countries: boolean;
  roads: boolean;
  water: boolean;
  pois: boolean;
}

export const ALL_LABELS_ON: LabelVisibility = {
  places: true,
  countries: true,
  roads: true,
  water: true,
  pois: true,
};

export const LABEL_CATEGORIES: Array<{ id: LabelCategory; label: string }> = [
  { id: 'countries', label: 'Countries' },
  { id: 'places', label: 'Cities & towns' },
  { id: 'roads', label: 'Roads' },
  { id: 'water', label: 'Water' },
  { id: 'pois', label: 'Points of interest' },
];

/**
 * Classify a style layer into a label category.
 *
 * There is no standard for layer naming across basemap styles, so this is
 * heuristic over the conventions OpenMapTiles-derived styles (OpenFreeMap's
 * Liberty/Bright/Positron, and ours) actually use. Anything unrecognised is
 * deliberately left alone rather than guessed at — hiding a layer the user
 * didn't ask about is worse than missing one.
 */
export function classifyLabelLayer(
  layerId: string,
  isSymbolWithText: boolean,
): LabelCategory | null {
  if (!isSymbolWithText) return null;
  const id = layerId.toLowerCase();

  // Our own overlays must never be touched by a basemap control.
  if (id.startsWith('marker-') || id.startsWith('route-') || id.startsWith('mm-')) {
    return null;
  }

  if (id.includes('country') || id.includes('continent')) return 'countries';
  if (
    id.includes('water') ||
    id.includes('ocean') ||
    id.includes('marine') ||
    id.includes('lake') ||
    id.includes('river')
  ) {
    return 'water';
  }
  if (
    id.includes('road') ||
    id.includes('highway') ||
    id.includes('street') ||
    id.includes('motorway') ||
    id.includes('shield') ||
    id.includes('junction')
  ) {
    return 'roads';
  }
  if (
    id.includes('poi') ||
    id.includes('amenity') ||
    id.includes('building') ||
    id.includes('transit') ||
    id.includes('station') ||
    id.includes('airport') ||
    id.includes('aerodrome')
  ) {
    return 'pois';
  }
  if (
    id.includes('place') ||
    id.includes('city') ||
    id.includes('town') ||
    id.includes('village') ||
    id.includes('state') ||
    id.includes('suburb') ||
    id.includes('neighbourhood') ||
    id.includes('neighborhood') ||
    id.includes('label')
  ) {
    return 'places';
  }
  return null;
}

/** Apply label visibility to every classifiable layer in the current style. */
export function applyLabelVisibility(map: MLMap, vis: LabelVisibility): void {
  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;
    const hasText = Boolean(
      (layer as { layout?: Record<string, unknown> }).layout?.['text-field'],
    );
    const category = classifyLabelLayer(layer.id, hasText);
    if (!category) continue;
    if (!map.getLayer(layer.id)) continue;
    map.setLayoutProperty(
      layer.id,
      'visibility',
      vis[category] ? 'visible' : 'none',
    );
  }
}

/** Count how many layers each category controls — used to grey out no-ops. */
export function countLabelLayers(map: MLMap): Record<LabelCategory, number> {
  const counts: Record<LabelCategory, number> = {
    places: 0,
    countries: 0,
    roads: 0,
    water: 0,
    pois: 0,
  };
  const style = map.getStyle();
  for (const layer of style?.layers ?? []) {
    if (layer.type !== 'symbol') continue;
    const hasText = Boolean(
      (layer as { layout?: Record<string, unknown> }).layout?.['text-field'],
    );
    const c = classifyLabelLayer(layer.id, hasText);
    if (c) counts[c] += 1;
  }
  return counts;
}

export type Projection = 'mercator' | 'globe';

/**
 * Switch projection. MapLibre added globe in v5; guard so a version without
 * it degrades to flat rather than throwing mid-render.
 */
export function applyProjection(map: MLMap, projection: Projection): boolean {
  const setter = (map as unknown as {
    setProjection?: (p: { type: string }) => void;
  }).setProjection;
  if (typeof setter !== 'function') return false;
  try {
    setter.call(map, { type: projection });
    return true;
  } catch {
    return false;
  }
}

const TERRAIN_SOURCE = 'mm-terrain-dem';
// Free AWS Open Data elevation tiles (ex-Mapzen). Same source PamPam uses
// for their hillshading — no key, no rate limit, permissive licence.
const TERRAIN_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * Toggle 3D terrain. Adds its own DEM source rather than reusing a style's,
 * so it works identically on every basemap.
 */
export function applyTerrain(map: MLMap, enabled: boolean, exaggeration = 1.2): void {
  try {
    if (!enabled) {
      map.setTerrain(null);
      return;
    }
    if (!map.getSource(TERRAIN_SOURCE)) {
      map.addSource(TERRAIN_SOURCE, {
        type: 'raster-dem',
        encoding: 'terrarium',
        tiles: [TERRAIN_TILES],
        tileSize: 256,
        maxzoom: 13,
        attribution: 'Terrain: Mapzen/AWS Open Data',
      });
    }
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration });
  } catch {
    // Terrain is decorative; never let it break the editor.
  }
}
