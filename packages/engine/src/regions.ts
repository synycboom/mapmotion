import type { EasingId } from './types';

/**
 * Region highlighting: animated fills over whole countries and named groups.
 *
 * This is the last capability Mapimator had that we didn't, and it is what
 * the history and geopolitics audience actually needs — "the EU in 1995 vs
 * 2025", "ASEAN member states", "countries that signed X". Those videos are
 * a whole genre, and none of them are makeable with pins and routes.
 *
 * Geometry lives in the app (a bundled boundary file); this module handles
 * only which codes are selected and how the fill animates, so both are pure
 * and testable.
 */

/** ISO 3166-1 alpha-3, which is what the bundled boundary file is keyed on. */
export type CountryCode = string;

export interface RegionGroup {
  id: string;
  label: string;
  /** Alpha-3 codes. */
  codes: readonly CountryCode[];
  hint: string;
}

/**
 * Named groups, because typing 27 country codes to highlight the EU is not a
 * feature. Membership is as of 2026 and deliberately not exhaustive — these
 * are the groupings people actually make videos about, and anything else can
 * be assembled by picking countries.
 */
export const REGION_GROUPS: readonly RegionGroup[] = [
  {
    id: 'eu',
    label: 'European Union',
    hint: '27 member states',
    codes: [
      'AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'FRA',
      'DEU', 'GRC', 'HUN', 'IRL', 'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD',
      'POL', 'PRT', 'ROU', 'SVK', 'SVN', 'ESP', 'SWE',
    ],
  },
  {
    id: 'asean',
    label: 'ASEAN',
    hint: 'Southeast Asian nations',
    codes: ['BRN', 'KHM', 'IDN', 'LAO', 'MYS', 'MMR', 'PHL', 'SGP', 'THA', 'VNM'],
  },
  {
    id: 'nordics',
    label: 'Nordics',
    hint: 'Denmark, Finland, Iceland, Norway, Sweden',
    codes: ['DNK', 'FIN', 'ISL', 'NOR', 'SWE'],
  },
  {
    id: 'g7',
    label: 'G7',
    hint: 'Canada, France, Germany, Italy, Japan, UK, USA',
    codes: ['CAN', 'FRA', 'DEU', 'ITA', 'JPN', 'GBR', 'USA'],
  },
  {
    id: 'brics',
    label: 'BRICS',
    hint: 'Brazil, Russia, India, China, South Africa and later members',
    codes: ['BRA', 'RUS', 'IND', 'CHN', 'ZAF', 'EGY', 'ETH', 'IRN', 'ARE'],
  },
  {
    id: 'mena',
    label: 'MENA',
    hint: 'Middle East and North Africa',
    codes: [
      'DZA', 'BHR', 'EGY', 'IRN', 'IRQ', 'ISR', 'JOR', 'KWT', 'LBN', 'LBY',
      'MAR', 'OMN', 'QAT', 'SAU', 'SYR', 'TUN', 'ARE', 'YEM',
    ],
  },
  {
    id: 'latam',
    label: 'Latin America',
    hint: 'Spanish- and Portuguese-speaking Americas',
    codes: [
      'ARG', 'BOL', 'BRA', 'CHL', 'COL', 'CRI', 'CUB', 'DOM', 'ECU', 'SLV',
      'GTM', 'HND', 'MEX', 'NIC', 'PAN', 'PRY', 'PER', 'URY', 'VEN',
    ],
  },
  {
    id: 'schengen',
    label: 'Schengen Area',
    hint: 'Passport-free travel zone',
    codes: [
      'AUT', 'BEL', 'BGR', 'HRV', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU',
      'GRC', 'HUN', 'ISL', 'ITA', 'LVA', 'LIE', 'LTU', 'LUX', 'MLT', 'NLD',
      'NOR', 'POL', 'PRT', 'ROU', 'SVK', 'SVN', 'ESP', 'SWE', 'CHE',
    ],
  },
];

const GROUP_BY_ID = new Map(REGION_GROUPS.map((g) => [g.id, g]));

export function regionGroup(id: string | undefined): RegionGroup | undefined {
  return id ? GROUP_BY_ID.get(id) : undefined;
}

/**
 * A highlighted set of countries, with its own colour and entrance.
 *
 * Several can coexist — "EU in blue, candidate states in amber" is the whole
 * point — so this is a track like routes and markers rather than a single
 * project-level setting.
 */
export interface RegionTrack {
  id: string;
  /** Alpha-3 codes, already resolved from any group selection. */
  codes: CountryCode[];
  /** Group this came from, kept so the UI can show it as one chip. */
  groupId?: string;
  label?: string;
  fillColor: string;
  /** Peak fill opacity, 0–1. */
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  /** When the fill starts appearing. */
  enterMs: number;
  enterDurationMs: number;
  easing?: EasingId;
}

/** Live state of one region at an instant. */
export interface RegionState {
  /** Multiplier on the track's own opacity, from the entrance animation. */
  progress: number;
}

export const DEFAULT_REGION = {
  fillColor: '#e8590c',
  fillOpacity: 0.35,
  lineColor: '#ffd8a8',
  lineWidth: 1.5,
  enterDurationMs: 700,
} as const;

/**
 * Normalise a code list: upper-cased, de-duplicated, order preserved.
 *
 * Duplicates matter more than they look — selecting both "EU" and "Schengen"
 * overlaps on 23 countries, and drawing those fills twice doubles their
 * opacity, so the shared members would render visibly darker than the rest.
 */
export function normaliseCodes(codes: readonly string[]): CountryCode[] {
  const seen = new Set<string>();
  const out: CountryCode[] = [];
  for (const raw of codes) {
    const code = String(raw ?? '').trim().toUpperCase();
    if (code.length !== 3 || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Expand a mixed list of group ids and country codes into country codes. */
export function resolveRegionSelection(selection: readonly string[]): CountryCode[] {
  const codes: string[] = [];
  for (const item of selection) {
    const group = regionGroup(String(item ?? '').toLowerCase());
    if (group) codes.push(...group.codes);
    else codes.push(item);
  }
  return normaliseCodes(codes);
}
