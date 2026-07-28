import { NextResponse } from 'next/server';
import { simplifyLine, type LngLat } from '@mapmotion/engine';

/**
 * Road routing for 'drive' legs.
 *
 * Proxied rather than called from the browser so the upstream can be swapped
 * (or given a key) without touching the client, and so responses can be
 * cached at the edge.
 *
 * Contract: this endpoint NEVER fails the caller. If the router is down,
 * rate-limited, or the two points aren't road-connected (different
 * continents, say), it returns `{ geometry: null, reason }` and the client
 * falls back to a great-circle arc. A routing outage should degrade the look
 * of a video, never break the editor.
 */

// FOSSGIS community OSRM instance — free, keyless, fair-use.
const UPSTREAM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving';
const TIMEOUT_MS = 6000;
const MAX_POINTS = 1200;

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = parsePoint(searchParams.get('from'));
  const to = parsePoint(searchParams.get('to'));

  if (!from || !to) {
    return NextResponse.json(
      { geometry: null, reason: 'bad-coordinates' },
      { status: 400 },
    );
  }

  const base = process.env.ROUTER_URL ?? UPSTREAM;
  const url =
    `${base}/${from[0]},${from[1]};${to[0]},${to[1]}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mapmotion/0.1 (map animation tool)' },
    });
    if (!res.ok) return degraded(`upstream-${res.status}`);

    const json = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: LngLat[] };
      }>;
    };
    if (json.code !== 'Ok' || !json.routes?.length) {
      return degraded(`upstream-code-${json.code ?? 'none'}`);
    }

    const coords = json.routes[0]!.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      return degraded('no-geometry');
    }

    // Simplify server-side: the client never needs the raw thousands of
    // points, and this keeps the response small.
    let geometry = simplifyLine(coords, 0.0015);
    if (geometry.length > MAX_POINTS) {
      geometry = simplifyLine(coords, 0.006);
    }

    return NextResponse.json(
      {
        geometry,
        distanceMeters: json.routes[0]!.distance ?? null,
        durationSeconds: json.routes[0]!.duration ?? null,
        points: geometry.length,
        rawPoints: coords.length,
      },
      { headers: { 'Cache-Control': 'public, max-age=86400' } },
    );
  } catch (e) {
    return degraded(
      (e as Error)?.name === 'AbortError' ? 'timeout' : 'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A routing miss is a normal, successful response — the client arcs instead. */
function degraded(reason: string) {
  return NextResponse.json({ geometry: null, reason }, { status: 200 });
}

function parsePoint(raw: string | null): LngLat | null {
  if (!raw) return null;
  const [lng, lat] = raw.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng! < -180 || lng! > 180 || lat! < -85 || lat! > 85) return null;
  return [lng!, lat!];
}
