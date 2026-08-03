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

// maxZoom 14, not 8. At zoom 8 the entire planet is a few dozen tiles, so a
// fly-through between three European cities requested TEN tiles in total and
// every one of them was already cached before the export began — which made
// the latency injection below completely inert. A real basemap has a distinct
// tile per z/x/y all the way down, so zooming into a stop is a fresh fetch.
const index = geojsonvt(countries, { maxZoom: 14, indexMaxZoom: 4, extent: 4096 });

const TILE_EXTENT = 4096;

/**
 * A synthetic one-feature layer marking a tile with its own identity.
 *
 * Inset from the tile edge so adjacent squares never touch: a hole between
 * two loaded tiles has to be a missing tile, not a seam. Emitted in
 * geojson-vt's internal shape (type 3 = polygon, tile-local coordinates)
 * because that is what vt-pbf consumes.
 */
function gridTile(z, x, y) {
  const inset = Math.round(TILE_EXTENT * 0.1);
  const a = inset;
  const b = TILE_EXTENT - inset;
  return {
    features: [
      {
        geometry: [[[a, a], [b, a], [b, b], [a, b], [a, a]]],
        type: 3,
        tags: { c: tileColour(z, x, y) },
        id: 0,
      },
    ],
    numPoints: 5,
    numSimplified: 5,
  };
}

/**
 * A colour unique to a tile. Neighbours differ by one in x or y, so the hash
 * has to scatter — an ordinary `(x + y) % n` would give diagonal stripes and
 * two adjacent tiles the same colour, which is exactly the case the grid
 * exists to disambiguate. Lightness stays high enough that no grid square can
 * be mistaken for the dark background a missing tile leaves behind.
 */
function tileColour(z, x, y) {
  const h =
    (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b) ^ Math.imul(z, 0xc2b2ae35)) >>> 0;
  return hsl(h % 360, 0.65, 0.55);
}

function hsl(hDeg, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hDeg / 60;
  const xx = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, xx, 0]
    : hp < 2 ? [xx, c, 0]
    : hp < 3 ? [0, c, xx]
    : hp < 4 ? [0, xx, c]
    : hp < 5 ? [xx, 0, c]
    : [c, 0, xx];
  const m = l - c / 2;
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * @param {number} port
 * @param {{tileLatencyMs?: number, jitterMs?: number, tileGrid?: boolean}} [opts]
 *   `tileLatencyMs` delays every tile response. Zero — the default, and what
 *   every existing suite uses — makes this an instant localhost server, which
 *   is exactly why the export looked flawless in CI and stuttered in
 *   production: `settle()`'s 900ms budget is never anywhere near exhausted
 *   when a tile arrives in under a millisecond. A real CDN is 40–300ms per
 *   tile, and a fresh viewport wants a dozen of them.
 *
 *   `tileGrid` adds a coloured inset square to every tile, keyed to its own
 *   z/x/y. Country polygons alone are useless for asking "did this tile
 *   arrive": over Paris at zoom 12 the answer is one flat cream rectangle
 *   whether four tiles loaded or one did. With the grid on, a tile that has
 *   not arrived is a visible hole of background colour, so frame completeness
 *   becomes a pixel measurement instead of an article of faith. Off by
 *   default so the other suites see exactly the basemap they always have.
 */
export function startMockTileServer(port = 3210, opts = {}) {
  const origin = `http://localhost:${port}`;
  const tileLatencyMs = opts.tileLatencyMs ?? 0;
  const jitterMs = opts.jitterMs ?? 0;
  const tileGrid = opts.tileGrid ?? false;
  // Deterministic jitter: a seeded LCG, not Math.random, so a failure is
  // reproducible rather than a coin toss.
  let seed = 0x2f6e2b1;
  const jitter = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return jitterMs === 0 ? 0 : (seed % jitterMs) | 0;
  };
  const stats = { tiles: 0, bytes: 0 };

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
      ...(tileGrid
        ? [
            {
              id: 'tilegrid',
              type: 'fill',
              source: 'mockvector',
              'source-layer': 'grid',
              // Colour comes from the feature, which encodes the tile's own
              // coordinates — so neighbouring tiles never share a colour and
              // a hole cannot be mistaken for its neighbour bleeding across.
              paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.85 },
            },
          ]
        : []),
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
    maxzoom: 14,
    vector_layers: tileGrid
      ? [{ id: 'countries', fields: {} }, { id: 'grid', fields: { c: 'String' } }]
      : [{ id: 'countries', fields: {} }],
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
      stats.tiles++;

      // The empty-tile case is delayed too. A CDN takes just as long to say
      // "nothing here" as to hand over geometry, and a mock that answers 204
      // instantly would quietly make half the fly-through free.
      const send = () => {
        // With the grid on, a tile is never empty: the marker square must be
        // present even where no country is, or "ocean" and "not loaded yet"
        // would look identical and the suite would be measuring nothing.
        if (!tile && !tileGrid) {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        const layers = {};
        if (tile) layers.countries = tile;
        if (tileGrid) layers.grid = gridTile(z, x, y);
        const buf = Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2, extent: 4096 }));
        stats.bytes += buf.length;
        res.writeHead(200, { ...cors, 'Content-Type': 'application/x-protobuf' });
        res.end(buf);
      };
      const wait = tileLatencyMs + jitter();
      if (wait > 0) setTimeout(send, wait);
      else send();
      return;
    }
    res.writeHead(404, cors);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, () =>
      resolve({ server, origin, styleUrl: `${origin}/styles/test`, stats }),
    );
  });
}
