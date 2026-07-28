import { describe, expect, it } from 'vitest';
import {
  buildTitleCards,
  compileTrip,
  sceneAt,
  titleOpacity,
  titlesAt,
  type TitleCard,
  type TripStop,
} from '../src/index';

const CARD: TitleCard = {
  id: 'c',
  text: 'Hello',
  startMs: 1000,
  endMs: 3000,
  fadeMs: 500,
};

const STOPS: TripStop[] = [
  { name: 'A', coordinate: [0, 0] },
  { name: 'B', coordinate: [10, 10] },
];

describe('titleOpacity', () => {
  it('is 0 outside the card window', () => {
    expect(titleOpacity(CARD, 999)).toBe(0);
    expect(titleOpacity(CARD, 3001)).toBe(0);
  });

  it('fades in and out symmetrically', () => {
    expect(titleOpacity(CARD, 1000)).toBe(0);
    expect(titleOpacity(CARD, 1250)).toBeCloseTo(0.5, 5);
    expect(titleOpacity(CARD, 1500)).toBe(1);
    expect(titleOpacity(CARD, 2500)).toBe(1);
    expect(titleOpacity(CARD, 2750)).toBeCloseTo(0.5, 5);
    expect(titleOpacity(CARD, 3000)).toBe(0);
  });

  it('is fully opaque at the midpoint even when the fade is longer than the card', () => {
    const short: TitleCard = { id: 's', text: 'x', startMs: 0, endMs: 400, fadeMs: 5000 };
    expect(titleOpacity(short, 200)).toBe(1);
  });

  it('handles zero-length and inverted cards without NaN', () => {
    expect(titleOpacity({ id: 'z', text: 'x', startMs: 100, endMs: 100 }, 100)).toBe(0);
    expect(titleOpacity({ id: 'i', text: 'x', startMs: 500, endMs: 100 }, 300)).toBe(0);
  });

  it('is always within [0,1]', () => {
    for (let t = -500; t < 4000; t += 17) {
      const o = titleOpacity(CARD, t);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
  });
});

describe('titlesAt', () => {
  it('returns only visible cards', () => {
    const cards = [CARD, { ...CARD, id: 'd', startMs: 5000, endMs: 7000 }];
    expect(titlesAt(cards, 2000).map((s) => s.card.id)).toEqual(['c']);
    expect(titlesAt(cards, 6000).map((s) => s.card.id)).toEqual(['d']);
    expect(titlesAt(cards, 4000)).toEqual([]);
  });

  it('tolerates an empty list', () => {
    expect(titlesAt([], 100)).toEqual([]);
  });
});

describe('buildTitleCards', () => {
  it('produces nothing without a title', () => {
    expect(buildTitleCards({ durationMs: 10_000 })).toEqual([]);
    expect(buildTitleCards({ title: '   ', durationMs: 10_000 })).toEqual([]);
  });

  it('makes an intro card that starts at zero', () => {
    const [intro] = buildTitleCards({ title: 'Trip', durationMs: 10_000 });
    expect(intro!.startMs).toBe(0);
    expect(intro!.endMs).toBeGreaterThan(1000);
    expect(intro!.endMs).toBeLessThanOrEqual(3200);
  });

  it('adds an outro only when asked and the video is long enough', () => {
    expect(buildTitleCards({ title: 'T', durationMs: 10_000, outro: true })).toHaveLength(2);
    expect(buildTitleCards({ title: 'T', durationMs: 3000, outro: true })).toHaveLength(1);
    expect(buildTitleCards({ title: 'T', durationMs: 10_000 })).toHaveLength(1);
  });

  it('never overlaps intro and outro', () => {
    for (const durationMs of [4200, 6000, 12_000, 60_000]) {
      const cards = buildTitleCards({ title: 'T', durationMs, outro: true });
      if (cards.length === 2) {
        expect(cards[1]!.startMs).toBeGreaterThan(cards[0]!.endMs);
      }
    }
  });

  it('keeps the outro inside the video', () => {
    const cards = buildTitleCards({ title: 'T', durationMs: 12_000, outro: true });
    expect(cards[1]!.endMs).toBe(12_000);
  });
});

describe('titles through compile + sceneAt', () => {
  it('compiles with no titles by default', () => {
    const p = compileTrip('t', STOPS);
    expect(p.titles).toEqual([]);
    expect(sceneAt(p, 0).titles).toEqual([]);
  });

  it('surfaces the intro card at t=small', () => {
    const p = compileTrip('t', STOPS, { title: 'My Trip', subtitle: '2026' });
    const s = sceneAt(p, 800);
    expect(s.titles).toHaveLength(1);
    expect(s.titles[0]!.card.text).toBe('My Trip');
    expect(s.titles[0]!.card.subtitle).toBe('2026');
    expect(s.titles[0]!.opacity).toBeGreaterThan(0);
  });

  it('has no title late in the video without an outro', () => {
    const p = compileTrip('t', STOPS, { title: 'My Trip' });
    expect(sceneAt(p, p.format.durationMs - 100).titles).toEqual([]);
  });

  it('shows the outro at the end when enabled', () => {
    const p = compileTrip('t', STOPS, { title: 'My Trip', outro: true });
    const s = sceneAt(p, p.format.durationMs - 400);
    expect(s.titles.map((x) => x.card.id)).toContain('outro');
  });

  it('stays deterministic', () => {
    const p = compileTrip('t', STOPS, { title: 'My Trip', outro: true });
    expect(sceneAt(p, 1234)).toEqual(sceneAt(p, 1234));
  });
});
