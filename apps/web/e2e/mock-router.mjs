// A local stand-in for the OSRM routing API. The sandbox proxy blocks the
// real one, and even in production we want a deterministic router in tests.
//
// Serves the OSRM v1 shape: /route/v1/driving/{lng,lat};{lng,lat}?...
// Modes (via constructor):
//   'ok'    -> returns a wiggly多-point "road" between the two points
//   'fail'  -> HTTP 503, to prove the client falls back to an arc
//   'noroute' -> valid response with code 'NoRoute' (e.g. across an ocean)
import { createServer } from 'node:http';

export function startMockRouter(port = 3220, mode = 'ok') {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const m = url.pathname.match(/\/route\/v1\/driving\/(.+)$/);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

    if (!m) {
      res.writeHead(404, cors);
      res.end('not found');
      return;
    }

    if (mode === 'fail') {
      res.writeHead(503, cors);
      res.end('upstream exploded');
      return;
    }

    const [a, b] = decodeURIComponent(m[1]).split(';').map((p) => p.split(',').map(Number));

    if (mode === 'noroute') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'NoRoute', routes: [] }));
      return;
    }

    // Build a road-ish polyline: 400 points along the pair with a lateral
    // wiggle, so it is unmistakably NOT our 97-point great-circle arc and
    // exercises the simplifier.
    const N = 400;
    const coordinates = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const lng = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      const wiggle = Math.sin(t * Math.PI * 6) * 0.35 * Math.sin(t * Math.PI);
      coordinates.push([
        Number((lng + wiggle).toFixed(6)),
        Number((lat + wiggle * 0.5).toFixed(6)),
      ]);
    }
    coordinates[0] = [a[0], a[1]];
    coordinates[N] = [b[0], b[1]];

    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 'Ok',
        routes: [
          {
            distance: 500000,
            duration: 21600,
            geometry: { type: 'LineString', coordinates },
          },
        ],
      }),
    );
  });

  return new Promise((resolve) => {
    server.listen(port, () =>
      resolve({ server, url: `http://localhost:${port}/route/v1/driving` }),
    );
  });
}
