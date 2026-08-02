'use client';

/**
 * Country boundary geometry for region highlighting.
 *
 * ~190KB of Natural Earth 1:110m polygons, keyed by ISO alpha-3. Loaded on
 * demand rather than bundled: most projects never highlight a region, and
 * making every visitor download a fifth of a megabyte of coastlines for a
 * feature they aren't using is exactly the kind of thing that quietly ruins
 * a first paint.
 *
 * Built by scripts/build-countries.mjs.
 */

export interface CountryFeature {
  type: 'Feature';
  id: string;
  properties: { a2: string; a3: string; name: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
}

export interface CountryCollection {
  type: 'FeatureCollection';
  features: CountryFeature[];
}

let cache: CountryCollection | null = null;
let inFlight: Promise<CountryCollection | null> | null = null;

/**
 * Fetch the boundary file, once per session.
 *
 * Concurrent callers share one request — the panel and the frame applier both
 * want it the moment a region is added, and two parallel 190KB downloads for
 * the same bytes is a silly way to be slow.
 */
export function loadCountries(): Promise<CountryCollection | null> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;

  inFlight = fetch('/data/countries.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((data: CountryCollection | null) => {
      cache = data && Array.isArray(data.features) ? data : null;
      return cache;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Already-loaded collection, or null. For synchronous render paths. */
export function countriesIfLoaded(): CountryCollection | null {
  return cache;
}

/** Name for a code, for the UI. Falls back to the code itself. */
export function countryName(code: string): string {
  const hit = cache?.features.find((f) => f.properties.a3 === code);
  return hit?.properties.name ?? code;
}

/**
 * Every country, sorted by name, for a picker. Empty until loaded.
 */
export function countryList(): Array<{ code: string; name: string }> {
  if (!cache) return [];
  return cache.features
    .map((f) => ({ code: f.properties.a3, name: f.properties.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
