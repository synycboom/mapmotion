import type { Map as MLMap } from 'maplibre-gl';
import {
  cumulativeDistances,
  sliceLine,
  type FrameState,
  type Project,
} from '@mapmotion/engine';
import { ensureVehicleIcons, vehicleImageId } from './vehicleIcons';

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
   * Remove everything Mapmotion owns from the map, by naming convention.
   *
   * Sweeping by prefix rather than by this instance's own list is deliberate:
   * a new FrameApplier is constructed on every project change, so its list
   * starts empty and it would have no idea about the *previous* applier's
   * layers. When a trip shrinks from 3 stops to 2, `route-route-2` has no
   * counterpart in the new project and would otherwise be orphaned on the map
   * forever — invisible, but accumulating, and enough to make code that looks
   * up "the route source" find the wrong one.
   */
  private teardown(): void {
    const map = this.map;
    const style = map.getStyle();
    if (!style) return;

    for (const layer of style.layers ?? []) {
      if (isOwnedLayer(layer.id) && map.getLayer(layer.id)) {
        map.removeLayer(layer.id);
      }
    }
    for (const id of Object.keys(style.sources ?? {})) {
      if (isOwnedSource(id) && map.getSource(id)) {
        map.removeSource(id);
      }
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
  /**
   * Every icon+colour this project's vehicles need.
   * Await `ensureIcons()` before rendering frames that must be complete —
   * an icon arriving late would produce an export frame with no vehicle.
   */
  vehiclePairs(): Array<{ icon: string; color: string }> {
    return this.project.routes
      .filter((r) => r.vehicle)
      .map((r) => ({ icon: r.vehicle!.icon, color: r.vehicle!.color }));
  }

  ensureIcons(): Promise<void> {
    return ensureVehicleIcons(this.map, this.vehiclePairs());
  }

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
      if (r.vehicle) {
        // A sprite that rides the path, rotated to face its direction of
        // travel. Replaces the plain head dot for modes that have a vehicle.
        this.addSource(`vehicle-${r.id}`, { type: 'geojson', data: emptyPoint() });
        this.addLayer({
          id: `route-vehicle-${r.id}`,
          type: 'symbol',
          source: `vehicle-${r.id}`,
          layout: {
            'icon-image': vehicleImageId(r.vehicle.icon, r.vehicle.color),
            'icon-size': ['*', 0.55, ['coalesce', ['get', 'size'], 1]],
            // Rotate against the map so the vehicle keeps facing along the
            // road even when the camera itself is rotating.
            'icon-rotation-alignment': 'map',
            'icon-rotate': ['coalesce', ['get', 'bearing'], 0],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: {
            'icon-opacity': ['coalesce', ['get', 'opacity'], 0],
          },
        });
      } else {
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
      // A frame can land between a style swap and the re-install; skip
      // rather than throw — the next frame will paint correctly.
      if (!routeSrc) continue;
      routeSrc.setData(
        coords.length >= 2
          ? {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: coords },
            }
          : emptyLine(),
      );

      const vehicle = frame.vehicles[r.id];
      const vehicleSrc = map.getSource(`vehicle-${r.id}`) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (vehicleSrc) {
        vehicleSrc.setData(
          vehicle && vehicle.opacity > 0
            ? {
                type: 'Feature',
                properties: {
                  bearing: vehicle.bearing,
                  opacity: vehicle.opacity,
                  size: vehicle.size,
                },
                geometry: { type: 'Point', coordinates: vehicle.coordinate },
              }
            : emptyPoint(),
        );
      }

      const headSrc = map.getSource(`head-${r.id}`) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (headSrc) {
        headSrc.setData(
          coords.length >= 2 && progress > 0 && progress < 1
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

/**
 * Ownership is decided by id prefix. Keep these in sync with install().
 * Anything else on the map belongs to the basemap style and must be left
 * alone.
 */
function isOwnedLayer(id: string): boolean {
  return (
    id.startsWith('route-line-') ||
    id.startsWith('route-head-') ||
    id.startsWith('route-vehicle-') ||
    id === 'marker-dots' ||
    id === 'marker-labels'
  );
}

function isOwnedSource(id: string): boolean {
  return (
    id.startsWith('route-') ||
    id.startsWith('head-') ||
    id.startsWith('vehicle-') ||
    id === 'markers'
  );
}

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
