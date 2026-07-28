import type { StyleSpecification } from 'maplibre-gl';
import { buildStyle as buildMinimalStyle } from './mapStyle';

/**
 * Style registry. Three kinds:
 *  - inline:  built locally, zero network (deterministic — used by CI/autotest)
 *  - url:     hosted style JSON (OpenFreeMap — free, keyless, OSM data)
 *  - derived: fetched hosted style transformed at runtime (our signature looks)
 *
 * Each style carries its own attribution (rendered on-screen AND composited
 * into exports — OSM's license requires it) and a per-frame settle budget for
 * the exporter (remote tiles need more headroom than local GeoJSON).
 */
export interface StyleDef {
  id: string;
  label: string;
  attribution: string;
  /** Max ms the exporter waits per frame for tiles to settle. */
  settleCapMs: number;
  /** Font stack for our marker labels — must exist in the style's glyphs. */
  markerFont: string;
  markerTextColor: string;
  markerHaloColor: string;
  resolve: () => string | StyleSpecification | Promise<StyleSpecification>;
}

const OFM_ATTRIBUTION = '© OpenFreeMap · © OpenStreetMap contributors';
const TERRAIN_ATTRIBUTION = 'Terrain: Mapzen/AWS Open Data';

export const STYLES: StyleDef[] = [
  {
    id: 'liberty',
    label: 'Liberty (streets)',
    attribution: OFM_ATTRIBUTION,
    settleCapMs: 3000,
    markerFont: 'Noto Sans Regular',
    markerTextColor: '#1a1a2e',
    markerHaloColor: '#ffffff',
    resolve: () => 'https://tiles.openfreemap.org/styles/liberty',
  },
  {
    id: 'bright',
    label: 'Bright (colorful)',
    attribution: OFM_ATTRIBUTION,
    settleCapMs: 3000,
    markerFont: 'Noto Sans Regular',
    markerTextColor: '#1a1a2e',
    markerHaloColor: '#ffffff',
    resolve: () => 'https://tiles.openfreemap.org/styles/bright',
  },
  {
    id: 'positron',
    label: 'Positron (light)',
    attribution: OFM_ATTRIBUTION,
    settleCapMs: 3000,
    markerFont: 'Noto Sans Regular',
    markerTextColor: '#1a1a2e',
    markerHaloColor: '#ffffff',
    resolve: () => 'https://tiles.openfreemap.org/styles/positron',
  },
  {
    id: 'paper',
    label: 'Paper (signature)',
    attribution: `${OFM_ATTRIBUTION} · ${TERRAIN_ATTRIBUTION}`,
    settleCapMs: 3500,
    markerFont: 'Noto Sans Regular',
    markerTextColor: '#2d2a26',
    markerHaloColor: '#faf6ef',
    resolve: buildPaperStyle,
  },
  {
    id: 'minimal',
    label: 'Minimal (offline)',
    attribution: 'Data: Natural Earth',
    settleCapMs: 900,
    markerFont: 'Noto Sans Regular',
    markerTextColor: '#ffffff',
    markerHaloColor: '#0e1726',
    resolve: buildMinimalStyle,
  },
];

export function getStyle(id: string | null | undefined): StyleDef {
  return STYLES.find((s) => s.id === id) ?? STYLES[0]!;
}

/**
 * Wrap an arbitrary style URL as a StyleDef (dev/testing: `?styleUrl=...`).
 * Lets us point the editor at a local stand-in server when the real tile
 * host is unreachable.
 */
export function customStyle(url: string): StyleDef {
  return {
    id: 'custom',
    label: 'Custom URL',
    attribution: 'Custom style',
    settleCapMs: 3000,
    markerFont: 'Noto Sans Regular',
    markerTextColor: '#1a1a2e',
    markerHaloColor: '#ffffff',
    resolve: () => url,
  };
}

/**
 * "Paper" — our signature look, following the PamPam recipe: a light OSM
 * basemap recolored (cream land, bold ink-blue water, quiet roads) with
 * subtle terrain hillshading from the free AWS terrarium elevation tiles.
 */
async function buildPaperStyle(): Promise<StyleSpecification> {
  const res = await fetch('https://tiles.openfreemap.org/styles/positron');
  if (!res.ok) throw new Error(`positron fetch failed: ${res.status}`);
  const style = (await res.json()) as StyleSpecification;

  const PALETTE = {
    land: '#f6f1e9',
    water: '#2451b3',
    green: '#dbe7d2',
    sand: '#f0e7d8',
    road: '#ffffff',
    roadCasing: '#e5ddd0',
    boundary: '#c9b8a0',
    label: '#57534e',
    labelHalo: '#faf6ef',
  };

  for (const layer of style.layers) {
    const id = layer.id.toLowerCase();
    const paint: Record<string, unknown> = (layer as { paint?: Record<string, unknown> }).paint ?? {};

    if (layer.type === 'background') {
      paint['background-color'] = PALETTE.land;
    } else if (layer.type === 'fill') {
      if (id.includes('water')) paint['fill-color'] = PALETTE.water;
      else if (id.includes('wood') || id.includes('park') || id.includes('grass') || id.includes('landcover'))
        paint['fill-color'] = PALETTE.green;
      else if (id.includes('sand') || id.includes('beach')) paint['fill-color'] = PALETTE.sand;
      else if (id.includes('residential') || id.includes('landuse')) paint['fill-color'] = PALETTE.land;
    } else if (layer.type === 'line') {
      if (id.includes('water')) paint['line-color'] = PALETTE.water;
      else if (id.includes('boundary')) paint['line-color'] = PALETTE.boundary;
      else if (id.includes('casing')) paint['line-color'] = PALETTE.roadCasing;
      else if (id.includes('road') || id.includes('highway') || id.includes('street') || id.includes('motorway'))
        paint['line-color'] = PALETTE.road;
    } else if (layer.type === 'symbol') {
      if (paint['text-color'] !== undefined || id.includes('label') || id.includes('place')) {
        paint['text-color'] = PALETTE.label;
        paint['text-halo-color'] = PALETTE.labelHalo;
      }
    }
    (layer as { paint?: Record<string, unknown> }).paint = paint;
  }

  // Terrain hillshade (PamPam's trick): free AWS Open Data terrarium tiles.
  style.sources = {
    ...style.sources,
    terrain: {
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 13,
      attribution: TERRAIN_ATTRIBUTION,
    },
  };

  // Insert hillshade beneath the first line/symbol layer so roads and labels
  // stay crisp above the relief.
  const hillshade = {
    id: 'mm-hillshade',
    type: 'hillshade' as const,
    source: 'terrain',
    paint: {
      'hillshade-exaggeration': 0.35,
      'hillshade-shadow-color': '#b8a88f',
      'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#c8b79c',
    },
  };
  const insertAt = style.layers.findIndex((l) => l.type === 'line' || l.type === 'symbol');
  if (insertAt === -1) style.layers.push(hillshade);
  else style.layers.splice(insertAt, 0, hillshade);

  style.name = 'mapmotion-paper';
  return style;
}
