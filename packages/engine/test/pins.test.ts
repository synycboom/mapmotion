import { describe, expect, it } from 'vitest';
import {
  compileTrip,
  DEFAULT_PIN,
  PIN_STYLES,
  pinStyle,
  resolvePin,
  type TripStop,
} from '../src/index';

const STOPS: TripStop[] = [
  { name: 'A', coordinate: [0, 0] },
  { name: 'B', coordinate: [10, 10] },
  { name: 'C', coordinate: [20, 20] },
];

describe('pin style registry', () => {
  it('resolves every declared style', () => {
    for (const s of PIN_STYLES) expect(pinStyle(s.id).id).toBe(s.id);
  });

  it('falls back to dot for unknown styles', () => {
    expect(pinStyle('nonsense').id).toBe('dot');
    expect(pinStyle(undefined).id).toBe('dot');
  });
});

describe('resolvePin', () => {
  it('returns the default with no input', () => {
    expect(resolvePin(undefined, undefined)).toEqual(DEFAULT_PIN);
  });

  it('layers override on top of base', () => {
    const r = resolvePin({ style: 'pin', color: '#111111' }, { color: '#222222' });
    expect(r.style).toBe('pin');
    expect(r.color).toBe('#222222');
  });

  it('clamps absurd sizes', () => {
    expect(resolvePin({ size: 999 }, undefined).size).toBe(3);
    expect(resolvePin({ size: -4 }, undefined).size).toBe(0.4);
    expect(resolvePin({ size: Number.NaN }, undefined).size).toBe(1);
  });

  it('suppresses the floating label for bubble and hidden pins', () => {
    // A bubble already contains the name; a second label would duplicate it.
    expect(resolvePin({ style: 'bubble', showLabel: true }, undefined).showLabel).toBe(false);
    expect(resolvePin({ style: 'none', showLabel: true }, undefined).showLabel).toBe(false);
  });

  it('falls back to a dot when the style has no content to render', () => {
    expect(resolvePin({ style: 'emoji' }, undefined).style).toBe('dot');
    expect(resolvePin({ style: 'emoji', emoji: '  ' }, undefined).style).toBe('dot');
    expect(resolvePin({ style: 'image' }, undefined).style).toBe('dot');
    expect(resolvePin({ style: 'emoji', emoji: '🏔' }, undefined).style).toBe('emoji');
  });

  it('does not mutate its inputs', () => {
    const base = { style: 'pin' as const, size: 5 };
    const copy = { ...base };
    resolvePin(base, undefined);
    expect(base).toEqual(copy);
  });
});

describe('pins through compileTrip', () => {
  it('gives every marker a resolved pin', () => {
    const p = compileTrip('t', STOPS);
    expect(p.markers).toHaveLength(3);
    for (const m of p.markers) expect(m.pin).toEqual(DEFAULT_PIN);
  });

  it('applies a project-wide default', () => {
    const p = compileTrip('t', STOPS, { pin: { style: 'pin', color: '#ff0000' } });
    expect(p.markers.every((m) => m.pin?.style === 'pin')).toBe(true);
    expect(p.markers.every((m) => m.pin?.color === '#ff0000')).toBe(true);
  });

  it('applies per-stop overrides on top of the default', () => {
    const p = compileTrip('t', STOPS, {
      pin: { style: 'dot' },
      pinOverrides: [null, { style: 'emoji', emoji: '⛰' }, undefined],
    });
    expect(p.markers[0]!.pin!.style).toBe('dot');
    expect(p.markers[1]!.pin!.style).toBe('emoji');
    expect(p.markers[1]!.pin!.emoji).toBe('⛰');
    expect(p.markers[2]!.pin!.style).toBe('dot');
  });

  it('keeps marker timing independent of pin style', () => {
    const plain = compileTrip('t', STOPS);
    const fancy = compileTrip('t', STOPS, { pin: { style: 'marker', size: 2 } });
    expect(fancy.markers.map((m) => m.enterMs)).toEqual(
      plain.markers.map((m) => m.enterMs),
    );
    expect(fancy.format.durationMs).toBe(plain.format.durationMs);
  });
});
