import type { EasingId, LngLat } from './types';
import { ease } from './easing';
import { bearingBetween, destination, distanceMeters } from './geo';

/**
 * Annotations: text, images and shapes anchored to the map.
 *
 * One object model rather than three features, because they differ only in
 * what they draw. Everything else — anchoring, timing, entrance, exit,
 * opacity — is shared, and building them separately would mean writing that
 * three times and having three subtly different answers to "when does it
 * disappear".
 *
 * Pure and DOM-free: the ring and arrowhead maths is exactly the sort of
 * thing that is obvious until you get the winding order wrong, and it is far
 * cheaper to catch that in Node than by looking at a map.
 */

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'circle';
export type AnnotationKind = 'text' | 'image' | ShapeKind;

export interface AnnotationSpec {
  id: AnnotationKind;
  label: string;
  glyph: string;
  /** How many clicks it takes to place. */
  points: 1 | 2;
  hint: string;
}

export const ANNOTATION_KINDS: readonly AnnotationSpec[] = [
  { id: 'text', label: 'Text', glyph: 'T', points: 1, hint: 'A label pinned to a place' },
  { id: 'arrow', label: 'Arrow', glyph: '↗', points: 2, hint: 'Movement, flow, direction' },
  { id: 'line', label: 'Line', glyph: '╱', points: 2, hint: 'A border, a boundary, a link' },
  { id: 'rect', label: 'Box', glyph: '▭', points: 2, hint: 'Frame an area' },
  { id: 'circle', label: 'Circle', glyph: '◯', points: 2, hint: 'A radius around a point' },
  { id: 'image', label: 'Image', glyph: '🖼', points: 1, hint: 'A logo or picture on the map' },
];

export function annotationSpec(kind: string): AnnotationSpec | undefined {
  return ANNOTATION_KINDS.find((k) => k.id === kind);
}

interface Common {
  id: string;
  /** Anchor points. One for text/image, two for every shape. */
  coordinates: LngLat[];
  color: string;
  opacity: number;
  enterMs: number;
  enterDurationMs: number;
  /** When it starts leaving. `null` means it stays to the end. */
  exitMs: number | null;
  exitDurationMs: number;
  easing?: EasingId;
}

export interface TextAnnotation extends Common {
  kind: 'text';
  text: string;
  fontSize: number;
  haloColor: string;
}

export interface ImageAnnotation extends Common {
  kind: 'image';
  imageUrl: string;
  /** Rendered width in pixels at scale 1. */
  sizePx: number;
}

export interface ShapeAnnotation extends Common {
  kind: ShapeKind;
  widthPx: number;
  fillColor: string;
  fillOpacity: number;
  dashed: boolean;
}

export type Annotation = TextAnnotation | ImageAnnotation | ShapeAnnotation;

export const DEFAULT_ANNOTATION = {
  color: '#e8590c',
  haloColor: '#0e1726',
  fillColor: '#e8590c',
  fillOpacity: 0.2,
  opacity: 1,
  fontSize: 18,
  widthPx: 3,
  sizePx: 80,
  enterDurationMs: 500,
  exitDurationMs: 400,
  dashed: false,
} as const;

export interface AnnotationState {
  /** Combined entrance/exit fade, 0–1. */
  opacity: number;
  /**
   * Draw-on progress for lines and arrows, 0–1. Shapes with a fill use it as
   * a scale instead, so a circle grows out of its centre.
   */
  progress: number;
}

/**
 * Evaluate every annotation at an instant.
 *
 * Entrance and exit are separate windows rather than one "visible from/to",
 * because a hard cut on a map annotation looks like a rendering glitch — the
 * eye reads a shape appearing instantly as a bug and a shape fading in as a
 * decision.
 */
export function annotationsAt(
  annotations: readonly Annotation[],
  tMs: number,
): Record<string, AnnotationState> {
  const out: Record<string, AnnotationState> = {};
  for (const a of annotations) {
    const enterLocal = (tMs - a.enterMs) / Math.max(1, a.enterDurationMs);
    const entering = ease(a.easing ?? 'easeOutCubic', enterLocal);

    let leaving = 1;
    if (a.exitMs !== null && a.exitMs !== undefined) {
      const exitLocal = (tMs - a.exitMs) / Math.max(1, a.exitDurationMs);
      leaving = 1 - ease('easeInCubic', exitLocal);
    }

    out[a.id] = {
      opacity: clamp01(a.opacity) * entering * leaving,
      progress: entering,
    };
  }
  return out;
}

/**
 * Rectangle ring from two opposite corners.
 *
 * Returned closed (first point repeated) and counter-clockwise, which is what
 * GeoJSON wants for an exterior ring — get the winding wrong and some
 * renderers fill the entire rest of the world instead.
 */
export function rectRing(a: LngLat, b: LngLat): LngLat[] {
  const west = Math.min(a[0], b[0]);
  const east = Math.max(a[0], b[0]);
  const south = Math.min(a[1], b[1]);
  const north = Math.max(a[1], b[1]);
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/**
 * Circle ring around a centre, through a point on its edge.
 *
 * A true geodesic circle, not an ellipse in degrees: at 60° latitude a
 * "circle" drawn by adding a constant to longitude and latitude is twice as
 * wide as it is tall, which looks like a bug at exactly the latitudes most of
 * our users live at.
 */
export function circleRing(centre: LngLat, edge: LngLat, steps = 64): LngLat[] {
  const radius = distanceMeters(centre, edge);
  const n = Math.max(8, Math.round(steps));
  const ring: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    ring.push(destination(centre, (i * 360) / n, radius));
  }
  ring.push(ring[0]!);
  return ring;
}

/**
 * The two barbs of an arrowhead at `to`, coming from `from`.
 *
 * Sized in metres so the head scales with the map rather than staying a fixed
 * pixel size that swamps a short arrow and vanishes on a long one. Capped at
 * a third of the shaft for the same reason.
 */
export function arrowHead(from: LngLat, to: LngLat, spreadDeg = 28): LngLat[][] {
  const length = distanceMeters(from, to);
  if (length < 1) return [];
  const head = Math.min(length / 3, Math.max(length * 0.12, 1));
  const back = (bearingBetween(from, to) + 180) % 360;
  return [
    [to, destination(to, (back - spreadDeg + 360) % 360, head)],
    [to, destination(to, (back + spreadDeg) % 360, head)],
  ];
}

/** Is this kind drawn as a filled polygon? */
export function isFilled(kind: AnnotationKind): boolean {
  return kind === 'rect' || kind === 'circle';
}

/** Is this kind drawn as a line? */
export function isStroked(kind: AnnotationKind): boolean {
  return kind === 'line' || kind === 'arrow' || kind === 'rect' || kind === 'circle';
}

/**
 * Do these coordinates describe a drawable annotation?
 *
 * Two-point shapes placed with both clicks in the same spot produce a
 * zero-size rectangle or a zero-radius circle — invisible, un-selectable, and
 * indistinguishable from a bug when the user wonders where their shape went.
 */
export function isPlaceable(kind: AnnotationKind, coordinates: readonly LngLat[]): boolean {
  const spec = annotationSpec(kind);
  if (!spec) return false;
  if (coordinates.length < spec.points) return false;
  if (spec.points === 1) return true;
  return distanceMeters(coordinates[0]!, coordinates[1]!) > 1;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
