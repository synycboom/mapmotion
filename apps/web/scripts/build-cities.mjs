// Prebuild: distill the 135k-city GeoNames dump down to a compact index of
// notable places, shipped with the app.
//
// Why bundle instead of always hitting a geocoder: autocomplete fires on every
// keystroke, and public geocoders (Nominatim/Photon) rate-limit hard and add
// 200-500ms per request. A local index answers the ~90% case (major cities)
// instantly, offline, with no rate limit and no key. The upstream geocoder is
// still there for everything else — see app/api/geocode/route.ts.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'data', 'cities.json');

if (existsSync(out) && !process.env.FORCE_CITIES) {
  console.log('cities.json already built');
  process.exit(0);
}

const all = require('all-the-cities');

// Capital cities (PPLC) and admin capitals (PPLA) are kept at a lower
// population bar — "Reykjavík" and "Bern" matter more than their headcount.
const MIN_POP = 90_000;
const CAPITAL_MIN_POP = 5_000;

const kept = all.filter((c) => {
  const isCapital = c.featureCode === 'PPLC' || c.featureCode === 'PPLA';
  return c.population >= (isCapital ? CAPITAL_MIN_POP : MIN_POP);
});

// Compact positional tuples instead of objects — roughly 3x smaller JSON.
// [name, country, lng, lat, population, isCapital]
const rows = kept
  .map((c) => [
    c.name,
    c.country,
    Math.round(c.loc.coordinates[0] * 1e4) / 1e4,
    Math.round(c.loc.coordinates[1] * 1e4) / 1e4,
    c.population,
    c.featureCode === 'PPLC' ? 1 : 0,
  ])
  .sort((a, b) => b[4] - a[4]);

mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(rows);
writeFileSync(out, json);
console.log(
  `wrote ${out}: ${rows.length} places, ${(json.length / 1024).toFixed(0)} KB`,
);
