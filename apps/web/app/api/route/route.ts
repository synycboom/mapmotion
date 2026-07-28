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

// FOSSGIS community OSRM instances — free, keyless, fair-use. One host per
// travel profile; the path segment differs, so the profile is validated
// against this allowlist rather than interpolated from user input.
const UPSTREAM_BY_PROFILE: Record<string, string> = {
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
};
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

  const requested = searchParams.get('profile') ?? 'car';
  const profile = requested in UPSTREAM_BY_PROFILE ? requested : 'car';
  // ROUTER_URL overrides every profile (used by tests against a mock).
  const base = process.env.ROUTER_URL ?? UPSTREAM_BY_PROFILE[profile]!;
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
        profile,
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
