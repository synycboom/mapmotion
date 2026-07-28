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
export interface MarkerTheme {
  font: string;
  textColor: string;
  haloColor: string;
}

const DEFAULT_THEME: MarkerTheme = {
  font: 'Noto Sans Regular',
  textColor: '#ffffff',
  haloColor: '#0e1726',
};

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

  /** Every layer/source id this applier owns, for clean teardown. */
  private ownedLayers: string[] = [];
  private ownedSources: string[] = [];

  /**
   * Remove anything a previous install left behind.
   *
   * install() runs on every style load AND every project change (different
   * stop count = different route ids). Without this, re-installing hits
   * MapLibre's "source already exists" and leaves the map half-wired — which
   * then surfaces as `undefined.setData` on the next frame. Making install
   * idempotent removes that whole class of bug.
   */
  private teardown(): void {
    const map = this.map;
    for (const id of this.ownedLayers) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of this.ownedSources) {
      if (map.getSource(id)) map.removeSource(id);
    }
    this.ownedLayers = [];
    this.ownedSources = [];
  }

  /** Track ids as we add them so teardown knows what to clean up. */
  private addSource(id: string, spec: Parameters<MLMap['addSource']>[1]): void {
    if (this.map.getSource(id)) {
      // Left over from an earlier applier on this same style.
      const stale = this.map.getStyle()?.layers.filter(
        (l) => (l as { source?: string }).source === id,
      );
      for (const l of stale ?? []) if (this.map.getLayer(l.id)) this.map.removeLayer(l.id);
      this.map.removeSource(id);
    }
    this.map.addSource(id, spec);
    this.ownedSources.push(id);
  }

  private addLayer(spec: Parameters<MLMap['addLayer']>[0]): void {
    if (this.map.getLayer(spec.id)) this.map.removeLayer(spec.id);
    this.map.addLayer(spec);
    this.ownedLayers.push(spec.id);
  }

  /**
   * Add route/marker sources+layers. Call after every style load —
   * `setStyle` wipes all custom sources/layers, so the editor re-installs
   * on each style switch. Safe to call repeatedly.
   */
  install(theme: MarkerTheme = DEFAULT_THEME): void {
    this.teardown();
    const map = this.map;

    for (const r of this.project.routes) {
      this.addSource(`route-${r.id}`, {
        type: 'geojson',
        data: emptyLine(),
      });
      this.addLayer({
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
      this.addSource(`head-${r.id}`, { type: 'geojson', data: emptyPoint() });
      this.addLayer({
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

    this.addSource('markers', {
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
    this.addLayer({
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
    this.addLayer({
      id: 'marker-labels',
      type: 'symbol',
      source: 'markers',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': [theme.font],
        'text-size': 15,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': theme.textColor,
        'text-halo-color': theme.haloColor,
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
      const routeSrc = map.getSource(`route-${r.id}`) as maplibregl.GeoJSONSource | undefined;
      const headSrc = map.getSource(`head-${r.id}`) as maplibregl.GeoJSONSource | undefined;
      // A frame can land between a style swap and the re-install; skip
      // rather than throw — the next frame will paint correctly.
      if (!routeSrc || !headSrc) continue;
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

    if (!map.getSource('markers')) return;
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
