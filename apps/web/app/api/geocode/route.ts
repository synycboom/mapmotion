import { NextResponse } from 'next/server';
import { nearestCity, searchCities, type CityRow, type PlaceHit } from '@mapmotion/engine';
import cities from '../../../data/cities.json';

const ROWS = cities as CityRow[];

/**
 * Place search.
 *
 * Strategy: answer from the bundled index first (instant, offline, no rate
 * limit — covers the great majority of autocomplete traffic), and only reach
 * for an upstream geocoder when the local index is thin. That keeps us off
 * Nominatim/Photon's rate limits, which would otherwise be the first thing to
 * break under real usage.
 */

const UPSTREAM = 'https://photon.komoot.io/api/';
const MIN_LOCAL_HITS = 4;
const UPSTREAM_TIMEOUT_MS = 2500;

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').slice(0, 120);
  const limit = Math.min(12, Math.max(1, Number(searchParams.get('limit')) || 8));

  // Reverse lookup: ?near=lat,lng. Answered entirely from the bundled index —
  // no upstream call, because photo import fires one of these per stop and a
  // rate-limited geocoder would turn a 20-stop trip into a 20-second wait.
  const near = searchParams.get('near');
  if (near) {
    const [lat, lng] = near.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ results: [], source: 'none' }, { status: 400 });
    }
    const hit = nearestCity(ROWS, [lng, lat]);
    return NextResponse.json(
      { results: hit ? [hit] : [], source: 'local-reverse' },
      { headers: { 'Cache-Control': 'public, max-age=86400' } },
    );
  }

  if (q.trim().length < 2) {
    return NextResponse.json({ results: [], source: 'none' });
  }

  const local = searchCities(ROWS, q, limit);
  if (local.length >= MIN_LOCAL_HITS || searchParams.get('local') === '1') {
    return NextResponse.json(
      { results: local, source: 'local' },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    );
  }

  // Thin local results — supplement from upstream, but never fail the request
  // because of it.
  let remote: PlaceHit[] = [];
  try {
    remote = await fetchUpstream(q, limit);
  } catch {
    // Upstream unreachable (offline, rate-limited, blocked). Local-only is a
    // perfectly good answer.
  }

  const merged = dedupe([...local, ...remote]).slice(0, limit);
  return NextResponse.json(
    { results: merged, source: remote.length ? 'local+upstream' : 'local' },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}

async function fetchUpstream(q: string, limit: number): Promise<PlaceHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const url = `${UPSTREAM}?q=${encodeURIComponent(q)}&limit=${limit}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mapmotion/0.1 (map animation tool)' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: Record<string, unknown>;
      }>;
    };
    return (json.features ?? [])
      .filter((f) => Array.isArray(f.geometry?.coordinates))
      .map((f) => {
        const p = f.properties ?? {};
        const name =
          (p.name as string) ??
          (p.city as string) ??
          (p.street as string) ??
          'Unknown';
        return {
          name,
          country: (p.countrycode as string) ?? '',
          coordinate: f.geometry!.coordinates!,
          population: 0,
          isCapital: false,
          score: 0,
        };
      });
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(hits: PlaceHit[]): PlaceHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.name.toLowerCase()}|${h.country}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
