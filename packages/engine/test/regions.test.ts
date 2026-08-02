import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION,
  REGION_GROUPS,
  compileTrip,
  normaliseCodes,
  regionGroup,
  resolveRegionSelection,
  sceneAt,
  type TripStop,
} from '../src';

const PAR: TripStop = { name: 'Paris', coordinate: [2.3522, 48.8566] };
const BER: TripStop = { name: 'Berlin', coordinate: [13.405, 52.52] };
const FMT = { width: 1280, height: 720, fps: 30 };

describe('region groups', () => {
  it('every group has plausible alpha-3 codes', () => {
    for (const g of REGION_GROUPS) {
      expect(g.codes.length).toBeGreaterThan(2);
      for (const c of g.codes) expect(c).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('no group lists the same country twice', () => {
    for (const g of REGION_GROUPS) {
      expect(new Set(g.codes).size).toBe(g.codes.length);
    }
  });

  it('the EU has 27 members', () => {
    expect(regionGroup('eu')?.codes).toHaveLength(27);
    // Two obvious regression traps: the UK left, Switzerland never joined.
    expect(regionGroup('eu')?.codes).not.toContain('GBR');
    expect(regionGroup('eu')?.codes).not.toContain('CHE');
  });

  it('Schengen includes non-EU members and excludes EU non-members', () => {
    const schengen = regionGroup('schengen')!.codes;
    expect(schengen).toContain('CHE');
    expect(schengen).toContain('NOR');
    expect(schengen).toContain('ISL');
    expect(schengen).not.toContain('IRL');
  });

  it('returns undefined for an unknown id rather than an empty group', () => {
    expect(regionGroup('narnia')).toBeUndefined();
    expect(regionGroup(undefined)).toBeUndefined();
  });
});

describe('normaliseCodes', () => {
  it('upper-cases and trims', () => {
    expect(normaliseCodes([' fra ', 'deu'])).toEqual(['FRA', 'DEU']);
  });

  it('drops duplicates, preserving first-seen order', () => {
    expect(normaliseCodes(['FRA', 'DEU', 'FRA'])).toEqual(['FRA', 'DEU']);
  });

  it('rejects anything that is not three characters', () => {
    expect(normaliseCodes(['FR', 'FRAN', '', 'FRA'])).toEqual(['FRA']);
  });

  it('survives nulls and non-strings from persisted state', () => {
    expect(normaliseCodes([null as never, undefined as never, 'FRA'])).toEqual(['FRA']);
  });
});

describe('resolveRegionSelection', () => {
  it('expands a group id into its members', () => {
    expect(resolveRegionSelection(['nordics'])).toEqual(['DNK', 'FIN', 'ISL', 'NOR', 'SWE']);
  });

  it('mixes group ids and bare country codes', () => {
    const out = resolveRegionSelection(['nordics', 'GBR']);
    expect(out).toContain('NOR');
    expect(out).toContain('GBR');
  });

  it('de-duplicates across overlapping groups', () => {
    // EU and Schengen share 23 members. Drawing those twice would render them
    // visibly darker than the rest — the fills stack.
    const out = resolveRegionSelection(['eu', 'schengen']);
    expect(new Set(out).size).toBe(out.length);
    expect(out.filter((c) => c === 'FRA')).toHaveLength(1);
  });

  it('treats an unknown id as a country code and then discards it', () => {
    expect(resolveRegionSelection(['narnia'])).toEqual([]);
    expect(resolveRegionSelection(['XYZ'])).toEqual(['XYZ']);
  });

  it('is case-insensitive on group ids', () => {
    expect(resolveRegionSelection(['EU'])).toHaveLength(27);
  });
});

describe('compileTrip regions', () => {
  it('compiles a group into a region track', () => {
    const p = compileTrip('t', [PAR, BER], {
      format: FMT,
      regions: [{ selection: ['eu'], groupId: 'eu', label: 'European Union' }],
    });
    expect(p.regions).toHaveLength(1);
    expect(p.regions![0]!.codes).toHaveLength(27);
    expect(p.regions![0]!.groupId).toBe('eu');
    expect(p.regions![0]!.fillColor).toBe(DEFAULT_REGION.fillColor);
  });

  it('supports several highlights with different colours', () => {
    const p = compileTrip('t', [PAR, BER], {
      format: FMT,
      regions: [
        { selection: ['eu'], fillColor: '#1971c2' },
        { selection: ['GBR', 'CHE'], fillColor: '#f08c00' },
      ],
    });
    expect(p.regions).toHaveLength(2);
    expect(p.regions![1]!.codes).toEqual(['GBR', 'CHE']);
    expect(p.regions![0]!.id).not.toBe(p.regions![1]!.id);
  });

  it('drops a selection that resolves to nothing', () => {
    const p = compileTrip('t', [PAR, BER], {
      format: FMT,
      regions: [{ selection: ['narnia'] }, { selection: [] }, { selection: ['FRA'] }],
    });
    expect(p.regions).toHaveLength(1);
    expect(p.regions![0]!.codes).toEqual(['FRA']);
  });

  it('times the entrance as a fraction of the finished video', () => {
    // Highlights are "from the start" or "when we get there", not "at 4200ms"
    // — and the video length isn't known until the legs are laid out.
    const p = compileTrip('t', [PAR, BER], {
      format: { ...FMT, durationMs: 10_000 },
      regions: [{ selection: ['FRA'], enterAt: 0.5 }],
    });
    expect(p.regions![0]!.enterMs).toBe(5000);
  });

  it('clamps a nonsense entrance and opacity', () => {
    const p = compileTrip('t', [PAR, BER], {
      format: { ...FMT, durationMs: 10_000 },
      regions: [
        { selection: ['FRA'], enterAt: 9, fillOpacity: 4 },
        { selection: ['DEU'], enterAt: -3, fillOpacity: -1 },
        { selection: ['ESP'], enterAt: NaN, fillOpacity: NaN },
      ],
    });
    expect(p.regions![0]!.enterMs).toBe(10_000);
    expect(p.regions![0]!.fillOpacity).toBe(1);
    expect(p.regions![1]!.enterMs).toBe(0);
    expect(p.regions![1]!.fillOpacity).toBe(0);
    expect(p.regions![2]!.fillOpacity).toBe(0);
  });

  it('leaves regions empty when none were asked for', () => {
    const p = compileTrip('t', [PAR, BER], { format: FMT });
    expect(p.regions).toEqual([]);
  });
});

describe('sceneAt regions', () => {
  const project = compileTrip('t', [PAR, BER], {
    format: { ...FMT, durationMs: 10_000 },
    regions: [{ selection: ['FRA'], enterAt: 0.5 }],
  });
  const id = project.regions![0]!.id;

  it('is invisible before its entrance', () => {
    expect(sceneAt(project, 0).regions[id]!.progress).toBe(0);
    expect(sceneAt(project, 4999).regions[id]!.progress).toBe(0);
  });

  it('fades in over the entrance window', () => {
    const mid = sceneAt(project, 5000 + DEFAULT_REGION.enterDurationMs / 2).regions[id]!.progress;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('is fully visible after it, and stays', () => {
    expect(sceneAt(project, 5000 + DEFAULT_REGION.enterDurationMs).regions[id]!.progress).toBe(1);
    expect(sceneAt(project, 9999).regions[id]!.progress).toBe(1);
  });

  it('reports an empty map when a project has no regions', () => {
    const plain = compileTrip('t', [PAR, BER], { format: FMT });
    expect(sceneAt(plain, 100).regions).toEqual({});
  });

  it('never returns a progress outside 0..1', () => {
    for (const t of [-5000, 0, 5000, 5100, 20_000]) {
      const v = sceneAt(project, t).regions[id]!.progress;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
