// A local stand-in for OpenFreeMap that mirrors its exact structure:
//   GET /styles/test  -> style JSON (referenced by URL, like OFM)
//   GET /planet       -> TileJSON (source indirection, like OFM)
//   GET /t/{z}/{x}/{y}.pbf -> real Mapbox Vector Tiles
//
// The sandbox proxy 403s tiles.openfreemap.org, so this lets us exercise the
// identical code path (remote-URL style + vector source + TileJSON hop) that
// the blank-basemap bug lived in.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const geojsonvtMod = require('geojson-vt');
const geojsonvt = geojsonvtMod.default ?? geojsonvtMod;
const vtpbfMod = require('vt-pbf');
const vtpbf = vtpbfMod.default ?? vtpbfMod;
const { feature } = require('topojson-client');

const topo = JSON.parse(
  readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'),
);
const countries = feature(topo, topo.objects.countries);

const index = geojsonvt(countries, { maxZoom: 8, indexMaxZoom: 5, extent: 4096 });

export function startMockTileServer(port = 3210) {
  const origin = `http://localhost:${port}`;

  const style = {
    version: 8,
    name: 'mock-remote-style',
    // Same glyph host the offline Minimal style uses. Unreachable from the
    // sandbox, which is fine: the label *layer* still exists, which is what
    // the appearance controls operate on.
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      // Indirection through TileJSON — exactly how OpenFreeMap's
      // `openmaptiles` source references /planet.
      mockvector: { type: 'vector', url: `${origin}/planet` },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b1d33' } },
      {
        id: 'land',
        type: 'fill',
        source: 'mockvector',
        'source-layer': 'countries',
        paint: { 'fill-color': '#f6f1e9', 'fill-outline-color': '#c9b8a0' },
      },
      // A label layer so the appearance controls have something real to
      // toggle. Classified as 'places' by its id.
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'mockvector',
        'source-layer': 'countries',
        layout: {
          'text-field': 'x',
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': '#57534e' },
      },
    ],
  };

  const tilejson = {
    tilejson: '2.2.0',
    tiles: [`${origin}/t/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 8,
    vector_layers: [{ id: 'countries', fields: {} }],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, origin);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };

    if (url.pathname === '/styles/test') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(style));
      return;
    }
    if (url.pathname === '/planet') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tilejson));
      return;
    }
    const m = url.pathname.match(/^\/t\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (m) {
      const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const tile = index.getTile(z, x, y);
      if (!tile) {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const buf = Buffer.from(
        vtpbf.fromGeojsonVt({ countries: tile }, { version: 2, extent: 4096 }),
      );
      res.writeHead(200, { ...cors, 'Content-Type': 'application/x-protobuf' });
      res.end(buf);
      return;
    }
    res.writeHead(404, cors);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, origin, styleUrl: `${origin}/styles/test` }));
  });
}
