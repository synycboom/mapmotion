import type { LegMode, TripStop } from '@mapmotion/engine';
import type { FormatId } from './urlState';

/**
 * One-click starting points.
 *
 * Activation is the metric the whole product thesis rests on (percentage of
 * signups who export a video), and a blank editor is the biggest thing
 * standing between a new user and their first export. A template gets them
 * to something worth watching in one click, which they then edit.
 *
 * Each template is expressed as ordinary editor state — nothing here is a
 * special case downstream.
 */
export interface Template {
  id: string;
  label: string;
  blurb: string;
  stops: TripStop[];
  legModes: LegMode[];
  format: FormatId;
  styleId: string;
  speed: number;
}

const t = (
  id: string,
  label: string,
  blurb: string,
  places: Array<[string, number, number]>,
  opts: { modes?: LegMode[]; format?: FormatId; styleId?: string; speed?: number } = {},
): Template => ({
  id,
  label,
  blurb,
  stops: places.map(([name, lng, lat]) => ({ name, coordinate: [lng, lat] })),
  legModes:
    opts.modes ?? places.slice(1).map(() => 'air' as LegMode),
  format: opts.format ?? '16x9',
  styleId: opts.styleId ?? 'liberty',
  speed: opts.speed ?? 1,
});

export const TEMPLATES: Template[] = [
  t(
    'world-tour',
    'World tour',
    'Long-haul flights across continents — the classic travel-vlog intro.',
    [
      ['London', -0.1276, 51.5074],
      ['Dubai', 55.2708, 25.2048],
      ['Bangkok', 100.5018, 13.7563],
      ['Sydney', 151.2093, -33.8688],
    ],
    { styleId: 'paper' },
  ),
  t(
    'road-trip',
    'Road trip',
    'Follows real roads down the California coast.',
    [
      ['San Francisco', -122.4194, 37.7749],
      ['Monterey', -121.8947, 36.6002],
      ['Santa Barbara', -119.6982, 34.4208],
      ['Los Angeles', -118.2437, 34.0522],
    ],
    { modes: ['car', 'car', 'car'], styleId: 'positron', speed: 0.9 },
  ),
  t(
    'city-hops',
    'Europe by rail',
    'Short hops between European capitals.',
    [
      ['Paris', 2.3522, 48.8566],
      ['Brussels', 4.3517, 50.8503],
      ['Amsterdam', 4.9041, 52.3676],
      ['Berlin', 13.405, 52.52],
      ['Prague', 14.4378, 50.0755],
    ],
    { styleId: 'bright', speed: 1.3 },
  ),
  t(
    'vertical-shorts',
    'Vertical short',
    'Framed 9:16 for TikTok, Reels and Shorts.',
    [
      ['Tokyo', 139.6917, 35.6895],
      ['Kyoto', 135.7681, 35.0116],
      ['Osaka', 135.5023, 34.6937],
    ],
    { modes: ['train', 'train'], format: '9x16', styleId: 'paper', speed: 1.2 },
  ),
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((x) => x.id === id);
}
