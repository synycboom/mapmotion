// Build the country-boundary GeoJSON that region highlighting fills.
//
// Natural Earth via world-atlas, at 1:110m. That resolution is coarse enough
// to see on a coastline at street zoom and completely adequate for the job:
// nobody highlighting "the EU" in a 15-second video is inspecting fjords, and
// the 1:50m file is fourteen times the size for a difference that only shows
// up at zooms where a whole-country fill makes no sense anyway.
//
// Codes are baked in here rather than looked up at runtime, so the app ships
// no mapping table and no ISO dependency.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { feature } from 'topojson-client';
import countries from 'i18n-iso-countries';

const SRC = new URL('../node_modules/world-atlas/countries-110m.json', import.meta.url);
const OUT = new URL('../apps/web/data/countries.json', import.meta.url);

/** Coordinate precision. 3dp is ~110m at the equator — finer than the source. */
const DP = 3;

const round = (n) => Math.round(n * 10 ** DP) / 10 ** DP;

/** Recursively round every coordinate; halves the file for no visible change. */
function trim(coords) {
  if (typeof coords[0] === 'number') return [round(coords[0]), round(coords[1])];
  return coords.map(trim);
}

const topo = JSON.parse(readFileSync(SRC, 'utf8'));
const collection = feature(topo, topo.objects.countries);

const features = [];
const missing = [];

for (const f of collection.features) {
  const numeric = String(f.id ?? '').padStart(3, '0');
  const a2 = countries.numericToAlpha2(numeric);
  const a3 = countries.numericToAlpha3(numeric);
  if (!a2 || !a3) {
    // Disputed or unrecognised territories have no ISO code. Kept out rather
    // than given a made-up one: a fill you cannot address is dead weight.
    missing.push(f.properties?.name ?? numeric);
    continue;
  }
  features.push({
    type: 'Feature',
    id: a3,
    properties: { a2, a3, name: f.properties?.name ?? a3 },
    geometry: { type: f.geometry.type, coordinates: trim(f.geometry.coordinates) },
  });
}

mkdirSync(new URL('../apps/web/data/', import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

const bytes = readFileSync(OUT).length;
console.log(`countries.json: ${features.length} countries, ${(bytes / 1024).toFixed(0)} KB`);
if (missing.length) console.log(`skipped (no ISO code): ${missing.join(', ')}`);
