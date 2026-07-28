/**
 * Place-search ranking. Pure functions — no DOM, no network — so the ranking
 * is unit-testable and identical on server and client.
 *
 * Rows are compact positional tuples produced by scripts/build-cities.mjs:
 *   [name, countryCode, lng, lat, population, isCapital]
 */

export type CityRow = [string, string, number, number, number, 0 | 1];

export interface PlaceHit {
  name: string;
  country: string;
  coordinate: [number, number];
  population: number;
  isCapital: boolean;
  /** Higher is better. */
  score: number;
}

/** Lowercase and strip diacritics so "zurich" matches "Zürich". */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Parse "Paris, FR" / "Paris France" style queries into a name and an
 * optional country hint.
 */
export function parseQuery(q: string): { name: string; country: string | null } {
  const parts = q.split(',');
  if (parts.length >= 2) {
    const tail = normalize(parts[parts.length - 1]!);
    if (tail.length >= 2 && tail.length <= 3) {
      return { name: normalize(parts.slice(0, -1).join(',')), country: tail.toUpperCase() };
    }
  }
  return { name: normalize(q), country: null };
}

/**
 * Rank places for an autocomplete query.
 *
 * Ordering intent: exact matches first, then prefix matches, then substrings;
 * population and capital status break ties so "Paris" surfaces France's
 * before Texas's.
 */
export function searchCities(
  rows: readonly CityRow[],
  query: string,
  limit = 8,
): PlaceHit[] {
  const { name: q, country } = parseQuery(query);
  if (q.length === 0) return [];

  const hits: PlaceHit[] = [];
  for (const row of rows) {
    const [name, cc, lng, lat, pop, cap] = row;
    if (country && cc !== country) continue;

    const n = normalize(name);
    let base: number;
    if (n === q) base = 1000;
    else if (n.startsWith(q)) base = 700;
    else if (n.includes(q)) base = 400;
    else continue;

    // Population contributes up to ~100 points on a log scale, so it breaks
    // ties without ever outranking a better textual match.
    const popScore = Math.min(100, Math.log10(Math.max(1, pop)) * 14);
    const capScore = cap ? 30 : 0;
    // Prefer shorter names on equal footing ("York" over "New York City"
    // when the query is "york").
    const lengthPenalty = Math.min(20, Math.max(0, n.length - q.length) * 0.5);

    hits.push({
      name,
      country: cc,
      coordinate: [lng, lat],
      population: pop,
      isCapital: cap === 1,
      score: base + popScore + capScore - lengthPenalty,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Collapse duplicates (same name + country) that GeoNames lists as
  // separate administrative entries.
  const seen = new Set<string>();
  const out: PlaceHit[] = [];
  for (const h of hits) {
    const key = `${normalize(h.name)}|${h.country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
