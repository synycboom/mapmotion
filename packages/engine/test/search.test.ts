import { describe, expect, it } from 'vitest';
import {
  normalize,
  parseQuery,
  searchCities,
  type CityRow,
} from '../src/search';

// [name, country, lng, lat, population, isCapital]
const ROWS: CityRow[] = [
  ['Paris', 'FR', 2.3488, 48.8534, 2138551, 1],
  ['Paris', 'US', -95.5555, 33.6609, 25171, 0],
  ['Bangkok', 'TH', 100.5014, 13.754, 5104476, 1],
  ['Bangkok', 'US', -83.3, 40.1, 1200, 0],
  ['Zürich', 'CH', 8.55, 47.3667, 341730, 0],
  ['New York City', 'US', -74.006, 40.7143, 8175133, 0],
  ['York', 'GB', -1.0827, 53.9591, 144202, 0],
  ['Tokyo', 'JP', 139.6917, 35.6895, 8336599, 1],
  ['San Francisco', 'US', -122.4194, 37.7749, 864816, 0],
];

describe('normalize', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalize('Zürich')).toBe('zurich');
    expect(normalize('  SÃO Paulo ')).toBe('sao paulo');
  });
});

describe('parseQuery', () => {
  it('extracts a country hint from "City, CC"', () => {
    expect(parseQuery('Paris, FR')).toEqual({ name: 'paris', country: 'FR' });
    expect(parseQuery('paris,us')).toEqual({ name: 'paris', country: 'US' });
  });

  it('leaves plain queries alone', () => {
    expect(parseQuery('Paris')).toEqual({ name: 'paris', country: null });
  });

  it('does not treat a long tail as a country code', () => {
    expect(parseQuery('Paris, France')).toEqual({
      name: 'paris, france',
      country: null,
    });
  });
});

describe('searchCities', () => {
  it('returns nothing for an empty query', () => {
    expect(searchCities(ROWS, '')).toEqual([]);
    expect(searchCities(ROWS, '   ')).toEqual([]);
  });

  it('ranks the bigger/capital city first for ambiguous names', () => {
    const [top] = searchCities(ROWS, 'paris');
    expect(top!.country).toBe('FR');
  });

  it('respects a country hint', () => {
    const [top] = searchCities(ROWS, 'paris, us');
    expect(top!.country).toBe('US');
  });

  it('matches diacritics insensitively', () => {
    const [top] = searchCities(ROWS, 'zurich');
    expect(top!.name).toBe('Zürich');
  });

  it('prefers exact matches over longer substring matches', () => {
    const [top] = searchCities(ROWS, 'york');
    expect(top!.name).toBe('York'); // not "New York City"
  });

  it('still finds substring matches', () => {
    const names = searchCities(ROWS, 'francisco').map((h) => h.name);
    expect(names).toContain('San Francisco');
  });

  it('is prefix-friendly for autocomplete', () => {
    const names = searchCities(ROWS, 'ban').map((h) => h.name);
    expect(names).toContain('Bangkok');
  });

  it('deduplicates identical name+country entries', () => {
    const dupes: CityRow[] = [
      ['Springfield', 'US', -89.6, 39.8, 116565, 0],
      ['Springfield', 'US', -72.5, 42.1, 153060, 0],
    ];
    expect(searchCities(dupes, 'springfield')).toHaveLength(1);
  });

  it('honours the limit', () => {
    expect(searchCities(ROWS, 'a', 2).length).toBeLessThanOrEqual(2);
  });

  it('returns usable coordinates', () => {
    const [tokyo] = searchCities(ROWS, 'tokyo');
    expect(tokyo!.coordinate[0]).toBeCloseTo(139.6917, 3);
    expect(tokyo!.coordinate[1]).toBeCloseTo(35.6895, 3);
  });
});
