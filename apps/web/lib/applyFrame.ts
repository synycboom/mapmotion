import type { Map as MLMap } from 'maplibre-gl';
import {
  cumulativeDistances,
  sliceLine,
  type FrameState,
  type Project,
} from '@mapmotion/engine';

/**
 * Applies a FrameState to a MapLibre map. Uses jumpTo (never easeTo) so the
 * engine owns ALL interpolation — this is what makes preview and export
 * pixel-identical.
 */
export class FrameApplier {
  private cumulative = new Map<string, number[]>();

  constructor(
    private map: MLMap,
    private project: Project,
  ) {
    for (const r of project.routes) {
      this.cumulative.set(r.id, cumulativeDistances(r.coordinates));
    }
  }

  /** Add route/marker sources+layers. Call once after style load. */
  install(): void {
    const map = this.map;

    for (const r of this.project.routes) {
      map.addSource(`route-${r.id}`, {
        type: 'geojson',
        data: emptyLine(),
      });
      map.addLayer({
        id: `route-line-${r.id}`,
        type: 'line',
        source: `route-${r.id}`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': r.color ?? '#e8590c',
          'line-width': r.widthPx ?? 4,
        },
      });
      // Moving head dot at the tip of the drawn route.
      map.addSource(`head-${r.id}`, { type: 'geojson', data: emptyPoint() });
      map.addLayer({
        id: `route-head-${r.id}`,
        type: 'circle',
        source: `head-${r.id}`,
        paint: {
          'circle-radius': (r.widthPx ?? 4) + 3,
          'circle-color': '#ffffff',
          'circle-stroke-color': r.color ?? '#e8590c',
          'circle-stroke-width': 2,
        },
      });
    }

    map.addSource('markers', {
      type: 'geojson',
      promoteId: 'id',
      data: {
        type: 'FeatureCollection',
        features: this.project.markers.map((m) => ({
          type: 'Feature' as const,
          id: m.id,
          properties: { id: m.id, label: m.label ?? '' },
          geometry: { type: 'Point' as const, coordinates: m.coordinate },
        })),
      },
    });
    map.addLayer({
      id: 'marker-dots',
      type: 'circle',
      source: 'markers',
      paint: {
        'circle-color': '#ffd43b',
        'circle-stroke-color': '#0e1726',
        'circle-stroke-width': 2,
        'circle-radius': ['*', 7, ['coalesce', ['feature-state', 'scale'], 0]],
        'circle-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
        'circle-stroke-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
      },
    });
    map.addLayer({
      id: 'marker-labels',
      type: 'symbol',
      source: 'markers',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 15,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#0e1726',
        'text-halo-width': 1.4,
        'text-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
      },
    });
  }

  apply(frame: FrameState): void {
    const map = this.map;

    map.jumpTo({
      center: frame.camera.center,
      zoom: frame.camera.zoom,
      bearing: frame.camera.bearing,
      pitch: frame.camera.pitch,
    });

    for (const r of this.project.routes) {
      const progress = frame.routeProgress[r.id] ?? 0;
      const cum = this.cumulative.get(r.id)!;
      const coords = sliceLine(r.coordinates, cum, progress);
      const routeSrc = map.getSource(`route-${r.id}`) as maplibregl.GeoJSONSource;
      const headSrc = map.getSource(`head-${r.id}`) as maplibregl.GeoJSONSource;
      if (coords.length >= 2) {
        routeSrc.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coords },
        });
        headSrc.setData(
          progress > 0 && progress < 1
            ? {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'Point',
                  coordinates: coords[coords.length - 1]!,
                },
              }
            : emptyPoint(),
        );
      } else {
        routeSrc.setData(emptyLine());
        headSrc.setData(emptyPoint());
      }
    }

    for (const m of this.project.markers) {
      const s = frame.markers[m.id] ?? { opacity: 0, scale: 0 };
      map.setFeatureState(
        { source: 'markers', id: m.id },
        { opacity: s.opacity, scale: s.scale },
      );
    }
  }
}

// maplibre types are imported as a namespace only where needed
import type maplibregl from 'maplibre-gl';

function emptyLine(): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  };
}

function emptyPoint(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
