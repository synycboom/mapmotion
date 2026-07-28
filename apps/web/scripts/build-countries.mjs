// Prebuild: convert world-atlas (Natural Earth 110m) TopoJSON into GeoJSON
// served from /public. Gives the spike a deterministic, offline basemap with
// zero tile-network dependencies. Real tile styles come in Phase 1.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { feature } = require('topojson-client');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'countries.geojson');

if (existsSync(out)) {
  console.log('countries.geojson already built');
  process.exit(0);
}

const topo = JSON.parse(
  readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'),
);
const geo = feature(topo, topo.objects.countries);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(geo));
console.log(
  `wrote ${out} (${geo.features.length} countries, ${(JSON.stringify(geo).length / 1024).toFixed(0)} KB)`,
);
