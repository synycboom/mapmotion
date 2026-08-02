'use client';

import type { Map as MLMap } from 'maplibre-gl';
import {
  arrowHead,
  circleRing,
  isFilled,
  rectRing,
  sliceLine,
  cumulativeDistances,
  type Annotation,
  type FrameState,
  type LngLat,
} from '@mapmotion/engine';

/**
 * Annotation geometry, built per frame.
 *
 * Three sources rather than one per annotation: MapLibre charges per source
 * and per layer, not per feature, so twenty arrows in three shared sources
 * costs a fraction of twenty sources with one feature each. Styling is
 * data-driven off feature properties, the same approach the marker layers use.
 *
 * Geometry is recomputed each frame because lines and arrows draw themselves
 * in — the shape at t=0.3 genuinely is a different shape, not the same one
 * faded.
 */

export const ANNOTATION_SOURCES = {
  line: 'mm-ann-line',
  fill: 'mm-ann-fill',
  point: 'mm-ann-point',
} as const;

export interface AnnotationGeometry {
  lines: GeoJSON.FeatureCollection;
  fills: GeoJSON.FeatureCollection;
  points: GeoJSON.FeatureCollection;
}

/** Sprite id for an annotation's image, content-addressed like marker pins. */
export function annotationImageId(id: string, url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `mm-annimg-${id}-${(h >>> 0).toString(36)}`;
}

export function buildAnnotationGeometry(
  annotations: readonly Annotation[],
  frame: FrameState,
): AnnotationGeometry {
  const lines: GeoJSON.Feature[] = [];
  const fills: GeoJSON.Feature[] = [];
  const points: GeoJSON.Feature[] = [];

  for (const a of annotations) {
    const state = frame.annotations[a.id];
    // Fully transparent annotations are dropped rather than drawn invisibly:
    // an empty source is cheaper than a full one at zero opacity, and this is
    // most of them for most of the video.
    if (!state || state.opacity <= 0.001) continue;

    const common = {
      id: a.id,
      color: a.color,
      opacity: state.opacity,
    };

    if (a.kind === 'text') {
      points.push({
        type: 'Feature',
        id: a.id,
        properties: {
          ...common,
          kind: 'text',
          text: a.text,
          size: a.fontSize,
          halo: a.haloColor,
          sprite: '',
        },
        geometry: { type: 'Point', coordinates: a.coordinates[0] ?? [0, 0] },
      });
      continue;
    }

    if (a.kind === 'image') {
      points.push({
        type: 'Feature',
        id: a.id,
        properties: {
          ...common,
          kind: 'image',
          text: '',
          size: a.sizePx,
          halo: '',
          sprite: a.imageUrl ? annotationImageId(a.id, a.imageUrl) : '',
        },
        geometry: { type: 'Point', coordinates: a.coordinates[0] ?? [0, 0] },
      });
      continue;
    }

    const [from, to] = a.coordinates;
    if (!from || !to) continue;

    if (isFilled(a.kind)) {
      const ring = a.kind === 'rect' ? rectRing(from, to) : circleRing(from, to);
      // Filled shapes grow from their anchor rather than drawing on, so the
      // whole ring is present from the first frame and only opacity moves.
      fills.push({
        type: 'Feature',
        id: a.id,
        properties: {
          ...common,
          fillColor: a.fillColor,
          fillOpacity: a.fillOpacity * state.opacity,
          width: a.widthPx,
          dashed: a.dashed ? 1 : 0,
        },
        geometry: { type: 'Polygon', coordinates: [ring as number[][]] },
      });
      lines.push(lineFeature(a, ring, 1));
      continue;
    }

    // Line and arrow: draw on from the start point.
    const shaft = drawOn([from, to], state.progress);
    lines.push(lineFeature(a, shaft, state.opacity));

    if (a.kind === 'arrow' && state.progress > 0.6) {
      // The head appears only once the shaft is most of the way there —
      // an arrowhead that leads its own line looks like two separate marks.
      const headOpacity = Math.min(1, (state.progress - 0.6) / 0.4);
      for (const barb of arrowHead(from, shaft[shaft.length - 1] ?? to)) {
        lines.push(lineFeature(a, barb, headOpacity, `${a.id}-head`));
      }
    }
  }

  return {
    lines: { type: 'FeatureCollection', features: lines },
    fills: { type: 'FeatureCollection', features: fills },
    points: { type: 'FeatureCollection', features: points },
  };
}

function lineFeature(
  a: Annotation,
  coords: readonly LngLat[],
  opacity: number,
  id = a.id,
): GeoJSON.Feature {
  const shape = a as Extract<Annotation, { widthPx: number }>;
  return {
    type: 'Feature',
    id,
    properties: {
      id: a.id,
      color: a.color,
      // Multiplied in here rather than animated via feature-state: several
      // features share one annotation id (an arrow is a shaft plus two
      // barbs), and feature-state is keyed by feature id.
      opacity: a.kind === 'arrow' || a.kind === 'line' ? opacity : a.opacity * opacity,
      width: shape.widthPx ?? 3,
      dashed: shape.dashed ? 1 : 0,
    },
    geometry: { type: 'LineString', coordinates: coords as unknown as number[][] },
  };
}

/** The first `progress` of a path, so a line strokes itself on. */
function drawOn(coords: LngLat[], progress: number): LngLat[] {
  if (progress >= 1) return coords;
  const sliced = sliceLine(coords, cumulativeDistances(coords), progress);
  return sliced.length >= 2 ? sliced : coords.slice(0, 1);
}

/** Layer specs, in draw order. Kept here so install and teardown agree. */
export function annotationLayers(): Array<Parameters<MLMap['addLayer']>[0]> {
  return [
    {
      id: 'annotation-fill',
      type: 'fill',
      source: ANNOTATION_SOURCES.fill,
      paint: {
        'fill-color': ['coalesce', ['get', 'fillColor'], '#e8590c'],
        'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0],
      },
    },
    {
      id: 'annotation-line',
      type: 'line',
      source: ANNOTATION_SOURCES.line,
      filter: ['!=', ['get', 'dashed'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#e8590c'],
        'line-width': ['coalesce', ['get', 'width'], 3],
        'line-opacity': ['coalesce', ['get', 'opacity'], 0],
      },
    },
    {
      // A separate layer purely for the dashed variant: line-dasharray is a
      // paint property that cannot be data-driven, so one layer cannot draw
      // both solid and dashed strokes.
      id: 'annotation-line-dashed',
      type: 'line',
      source: ANNOTATION_SOURCES.line,
      filter: ['==', ['get', 'dashed'], 1],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#e8590c'],
        'line-width': ['coalesce', ['get', 'width'], 3],
        'line-opacity': ['coalesce', ['get', 'opacity'], 0],
        'line-dasharray': [2, 1.6],
      },
    },
    {
      id: 'annotation-image',
      type: 'symbol',
      source: ANNOTATION_SOURCES.point,
      filter: ['==', ['get', 'kind'], 'image'],
      layout: {
        'icon-image': ['get', 'sprite'],
        'icon-size': ['*', 0.5, ['/', ['coalesce', ['get', 'size'], 80], 80]],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['coalesce', ['get', 'opacity'], 0] },
    },
    {
      id: 'annotation-text',
      type: 'symbol',
      source: ANNOTATION_SOURCES.point,
      filter: ['==', ['get', 'kind'], 'text'],
      layout: {
        'text-field': ['get', 'text'],
        'text-size': ['coalesce', ['get', 'size'], 18],
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['coalesce', ['get', 'color'], '#ffffff'],
        'text-halo-color': ['coalesce', ['get', 'halo'], '#0e1726'],
        'text-halo-width': 1.6,
        'text-opacity': ['coalesce', ['get', 'opacity'], 0],
      },
    },
  ] as never;
}
