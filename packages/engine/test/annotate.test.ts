import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_KINDS,
  DEFAULT_ANNOTATION,
  annotationSpec,
  annotationsAt,
  arrowHead,
  circleRing,
  destination,
  distanceMeters,
  isFilled,
  isPlaceable,
  isStroked,
  rectRing,
  type Annotation,
  type LngLat,
} from '../src';

const PAR: LngLat = [2.3522, 48.8566];

function shape(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1',
    kind: 'line',
    coordinates: [PAR, [3, 49]],
    color: DEFAULT_ANNOTATION.color,
    opacity: 1,
    enterMs: 1000,
    enterDurationMs: 500,
    exitMs: null,
    exitDurationMs: 400,
    widthPx: 3,
    fillColor: DEFAULT_ANNOTATION.fillColor,
    fillOpacity: 0.2,
    dashed: false,
    ...over,
  } as Annotation;
}

describe('destination', () => {
  it('moves the right distance', () => {
    const d = destination(PAR, 90, 10_000);
    expect(distanceMeters(PAR, d)).toBeCloseTo(10_000, -1);
  });

  it('moves in the right direction', () => {
    expect(destination(PAR, 0, 10_000)[1]).toBeGreaterThan(PAR[1]);
    expect(destination(PAR, 180, 10_000)[1]).toBeLessThan(PAR[1]);
    expect(destination(PAR, 90, 10_000)[0]).toBeGreaterThan(PAR[0]);
    expect(destination(PAR, 270, 10_000)[0]).toBeLessThan(PAR[0]);
  });

  it('wraps longitude across the antimeridian instead of running off', () => {
    // Coordinates outside [-180, 180] make MapLibre draw all the way round.
    const east = destination([179.9, 0], 90, 40_000);
    expect(east[0]).toBeGreaterThanOrEqual(-180);
    expect(east[0]).toBeLessThanOrEqual(180);
    expect(east[0]).toBeLessThan(0);
  });

  it('is exact at the equator, where a degree is a known distance', () => {
    const p = destination([0, 0], 90, 111_195);
    expect(p[0]).toBeCloseTo(1, 2);
  });
});

describe('rectRing', () => {
  it('is closed', () => {
    const ring = rectRing([0, 0], [1, 1]);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(5);
  });

  it('normalises corners given in any order', () => {
    expect(rectRing([1, 1], [0, 0])).toEqual(rectRing([0, 0], [1, 1]));
    expect(rectRing([0, 1], [1, 0])).toEqual(rectRing([0, 0], [1, 1]));
  });

  it('is counter-clockwise, as GeoJSON exterior rings must be', () => {
    // Shoelace: positive area means counter-clockwise. Get this backwards and
    // some renderers fill the entire rest of the world.
    const ring = rectRing([0, 0], [2, 3]);
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
    }
    expect(area).toBeGreaterThan(0);
  });

  it('spans exactly the two corners', () => {
    const ring = rectRing([-3, 10], [5, 40]);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    expect(Math.min(...lngs)).toBe(-3);
    expect(Math.max(...lngs)).toBe(5);
    expect(Math.min(...lats)).toBe(10);
    expect(Math.max(...lats)).toBe(40);
  });
});

describe('circleRing', () => {
  it('is closed and has the requested resolution', () => {
    const ring = circleRing(PAR, destination(PAR, 0, 5000), 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
  });

  it('every point is the same distance from the centre', () => {
    const ring = circleRing(PAR, destination(PAR, 0, 20_000), 24);
    for (const p of ring) {
      expect(distanceMeters(PAR, p)).toBeCloseTo(20_000, -2);
    }
  });

  it('is a circle on the ground at high latitude, not an ellipse', () => {
    // The whole reason this is geodesic. A flat degree offset at 65°N would
    // come out more than twice as wide as it is tall.
    const oslo: LngLat = [10.75, 59.91];
    const ring = circleRing(oslo, destination(oslo, 0, 50_000), 4);
    const north = distanceMeters(oslo, ring[0]!);
    const east = distanceMeters(oslo, ring[1]!);
    expect(Math.abs(north - east)).toBeLessThan(500);
  });

  it('degrades to a tiny ring rather than throwing on a zero radius', () => {
    const ring = circleRing(PAR, PAR, 16);
    expect(ring).toHaveLength(17);
    for (const p of ring) expect(Number.isFinite(p[0])).toBe(true);
  });

  it('never drops below a usable number of segments', () => {
    expect(circleRing(PAR, destination(PAR, 0, 1000), 2).length).toBeGreaterThan(8);
  });
});

describe('arrowHead', () => {
  const from: LngLat = [0, 0];
  const to: LngLat = [1, 0];

  it('produces two barbs meeting at the tip', () => {
    const barbs = arrowHead(from, to);
    expect(barbs).toHaveLength(2);
    expect(barbs[0]![0]).toEqual(to);
    expect(barbs[1]![0]).toEqual(to);
  });

  it('points backwards along the shaft', () => {
    // Both barbs must end WEST of the tip for an eastward arrow, or the head
    // is on the wrong end.
    const barbs = arrowHead(from, to);
    expect(barbs[0]![1]![0]).toBeLessThan(to[0]);
    expect(barbs[1]![1]![0]).toBeLessThan(to[0]);
  });

  it('spreads to both sides', () => {
    const barbs = arrowHead(from, to);
    expect(Math.sign(barbs[0]![1]![1])).not.toBe(Math.sign(barbs[1]![1]![1]));
  });

  it('scales with the shaft rather than staying a fixed size', () => {
    const shortHead = distanceMeters(to, arrowHead(from, to)[0]![1]!);
    const longHead = distanceMeters([10, 0], arrowHead(from, [10, 0])[0]![1]!);
    expect(longHead).toBeGreaterThan(shortHead);
  });

  it('never lets the head swallow the shaft', () => {
    const shaft = distanceMeters(from, to);
    const head = distanceMeters(to, arrowHead(from, to)[0]![1]!);
    expect(head).toBeLessThanOrEqual(shaft / 3 + 1);
  });

  it('returns nothing for a zero-length arrow', () => {
    expect(arrowHead(from, from)).toEqual([]);
  });
});

describe('annotationsAt', () => {
  it('is invisible before its entrance', () => {
    const s = annotationsAt([shape()], 500);
    expect(s.a1!.opacity).toBe(0);
  });

  it('fades in over the entrance window', () => {
    const mid = annotationsAt([shape()], 1250).a1!.opacity;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('is fully visible after it and stays without an exit', () => {
    expect(annotationsAt([shape()], 1500).a1!.opacity).toBe(1);
    expect(annotationsAt([shape()], 999_999).a1!.opacity).toBe(1);
  });

  it('fades back out at its exit', () => {
    const a = shape({ exitMs: 5000, exitDurationMs: 400 });
    expect(annotationsAt([a], 4999).a1!.opacity).toBe(1);
    expect(annotationsAt([a], 5200).a1!.opacity).toBeLessThan(1);
    expect(annotationsAt([a], 5400).a1!.opacity).toBe(0);
    expect(annotationsAt([a], 9000).a1!.opacity).toBe(0);
  });

  it('scales by the annotation\'s own opacity', () => {
    expect(annotationsAt([shape({ opacity: 0.5 })], 2000).a1!.opacity).toBeCloseTo(0.5, 6);
  });

  it('clamps a nonsense opacity instead of passing it through', () => {
    expect(annotationsAt([shape({ opacity: 9 })], 2000).a1!.opacity).toBe(1);
    expect(annotationsAt([shape({ opacity: NaN })], 2000).a1!.opacity).toBe(0);
  });

  it('reports draw-on progress separately from opacity', () => {
    // A line draws itself in; the fade and the draw are different things and
    // a shape that only faded would look like a slide, not a stroke.
    const s = annotationsAt([shape()], 1250).a1!;
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(1);
  });

  it('keeps every value inside 0..1 at any time', () => {
    const a = shape({ exitMs: 5000 });
    for (const t of [-1e6, 0, 1200, 5100, 1e6]) {
      const st = annotationsAt([a], t).a1!;
      expect(st.opacity).toBeGreaterThanOrEqual(0);
      expect(st.opacity).toBeLessThanOrEqual(1);
      expect(st.progress).toBeGreaterThanOrEqual(0);
      expect(st.progress).toBeLessThanOrEqual(1);
    }
  });

  it('handles an empty list', () => {
    expect(annotationsAt([], 100)).toEqual({});
  });
});

describe('kinds', () => {
  it('every kind has a spec with a sane click count', () => {
    for (const k of ANNOTATION_KINDS) {
      expect([1, 2]).toContain(k.points);
      expect(annotationSpec(k.id)).toBe(k);
    }
  });

  it('classifies fills and strokes', () => {
    expect(isFilled('rect')).toBe(true);
    expect(isFilled('circle')).toBe(true);
    expect(isFilled('line')).toBe(false);
    expect(isFilled('text')).toBe(false);
    expect(isStroked('arrow')).toBe(true);
    expect(isStroked('rect')).toBe(true);
    expect(isStroked('image')).toBe(false);
  });

  it('returns undefined for an unknown kind', () => {
    expect(annotationSpec('hexagon')).toBeUndefined();
  });
});

describe('isPlaceable', () => {
  it('accepts a single point for text and images', () => {
    expect(isPlaceable('text', [PAR])).toBe(true);
    expect(isPlaceable('image', [PAR])).toBe(true);
    expect(isPlaceable('text', [])).toBe(false);
  });

  it('needs two distinct points for a shape', () => {
    expect(isPlaceable('rect', [PAR])).toBe(false);
    expect(isPlaceable('rect', [PAR, [3, 49]])).toBe(true);
  });

  it('rejects two clicks in the same spot', () => {
    // A zero-size rectangle is invisible and un-selectable, which reads as
    // "my shape vanished" rather than "I mis-clicked".
    expect(isPlaceable('rect', [PAR, PAR])).toBe(false);
    expect(isPlaceable('circle', [PAR, [PAR[0], PAR[1]]])).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isPlaceable('hexagon' as never, [PAR, [3, 49]])).toBe(false);
  });
});
