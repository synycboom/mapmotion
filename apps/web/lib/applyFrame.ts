import type { Map as MLMap } from 'maplibre-gl';
import {
  cumulativeDistances,
  sliceLine,
  type FrameState,
  type Project,
} from '@mapmotion/engine';
import { ensureMarkerImages, ensureVehicleIcons, vehicleImageId } from './vehicleIcons';
import { DEFAULT_PIN } from '@mapmotion/engine';

/** Prefix for every user-supplied marker image, so stale ones can be swept. */
export const MARKER_IMAGE_PREFIX = 'mm-pinimg-';

/**
 * Image id for a marker's own picture.
 *
 * The URL is folded into the id, not just the marker id. Marker ids are
 * positional (`marker-0`, `marker-1`), so importing a second folder of photos
 * reuses them — and an id-only key plus the `hasImage` guard would show the
 * PREVIOUS trip's photograph on the new trip's first stop.
 */
export function markerImageId(markerId: string, url?: string): string {
  return `${MARKER_IMAGE_PREFIX}${markerId}-${hash(url ?? '')}`;
}

/** FNV-1a, 32-bit. Only needs to separate different images, not resist attack. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

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
    const pairs = this.project.routes
      .filter((r) => r.vehicle)
      .map((r) => ({ icon: r.vehicle!.icon, color: r.vehicle!.color }));
    // Pin and marker styles use the same rasterisation path as vehicles.
    for (const m of this.project.markers) {
      const pin = m.pin;
      if (pin?.style === 'pin') pairs.push({ icon: 'pinshape', color: pin.color });
      if (pin?.style === 'marker') pairs.push({ icon: 'markershape', color: pin.color });
    }
    return pairs;
  }

  /** Marker images the project needs, as (sprite id, source URL) pairs. */
  markerImages(): Array<{ id: string; url: string }> {
    return this.project.markers
      .filter((m) => m.pin?.style === 'image' && m.pin.imageUrl)
      .map((m) => ({ id: markerImageId(m.id, m.pin!.imageUrl), url: m.pin!.imageUrl! }));
  }

  async ensureIcons(): Promise<void> {
    await Promise.all([
      ensureVehicleIcons(this.map, this.vehiclePairs()),
      ensureMarkerImages(this.map, this.markerImages()),
    ]);
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

    // Markers carry their resolved appearance as feature properties, so one
    // source + a few data-driven layers cover every pin style.
    this.addSource('markers', {
      type: 'geojson',
      promoteId: 'id',
      data: {
        type: 'FeatureCollection',
        features: this.project.markers.map((m) => {
          const pin = m.pin ?? DEFAULT_PIN;
          return {
            type: 'Feature' as const,
            id: m.id,
            properties: {
              id: m.id,
              label: m.label ?? '',
              style: pin.style,
              color: pin.color,
              size: pin.size,
              showLabel: pin.showLabel ? 1 : 0,
              emoji: pin.emoji ?? '',
              sprite:
                pin.style === 'pin'
                  ? vehicleImageId('pinshape', pin.color)
                  : pin.style === 'marker'
                    ? vehicleImageId('markershape', pin.color)
                    : pin.style === 'image'
                      ? markerImageId(m.id, pin.imageUrl)
                      : '',
              bubble: m.label ?? '',
            },
            geometry: { type: 'Point' as const, coordinates: m.coordinate },
          };
        }),
      },
    });

    // Dot style.
    this.addLayer({
      id: 'marker-dots',
      type: 'circle',
      source: 'markers',
      filter: ['==', ['get', 'style'], 'dot'],
      paint: {
        'circle-color': ['coalesce', ['get', 'color'], '#ffd43b'],
        'circle-stroke-color': '#0e1726',
        'circle-stroke-width': 2,
        'circle-radius': [
          '*',
          ['*', 7, ['coalesce', ['get', 'size'], 1]],
          ['coalesce', ['feature-state', 'scale'], 0],
        ],
        'circle-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
        'circle-stroke-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
      },
    });

    // Pin / marker / image styles all render as a bottom-anchored sprite.
    this.addLayer({
      id: 'marker-sprites',
      type: 'symbol',
      source: 'markers',
      filter: ['in', ['get', 'style'], ['literal', ['pin', 'marker', 'image']]],
      layout: {
        'icon-image': ['get', 'sprite'],
        // Size comes from a feature PROPERTY, not feature-state: MapLibre
        // rejects feature-state in layout properties, and icon-size is
        // layout. So sprite pins animate in on opacity alone (a paint
        // property) rather than the scale-pop the dot style uses.
        'icon-size': ['*', 0.5, ['coalesce', ['get', 'size'], 1]],
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['coalesce', ['feature-state', 'opacity'], 0] },
    });

    // Emoji renders as text — no sprite rasterisation needed.
    this.addLayer({
      id: 'marker-emoji',
      type: 'symbol',
      source: 'markers',
      filter: ['==', ['get', 'style'], 'emoji'],
      layout: {
        'text-field': ['get', 'emoji'],
        'text-font': [theme.font],
        'text-size': ['*', 28, ['coalesce', ['get', 'size'], 1]],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-opacity': ['coalesce', ['feature-state', 'opacity'], 0] },
    });

    // Bubble: the name inside a rounded badge, so no separate label.
    this.addLayer({
      id: 'marker-bubbles',
      type: 'symbol',
      source: 'markers',
      filter: ['==', ['get', 'style'], 'bubble'],
      layout: {
        'text-field': ['get', 'bubble'],
        'text-font': [theme.font],
        'text-size': ['*', 14, ['coalesce', ['get', 'size'], 1]],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-padding': 0,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': ['coalesce', ['get', 'color'], '#e8590c'],
        'text-halo-width': 2.5,
        'text-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
      },
    });

    this.addLayer({
      id: 'marker-labels',
      type: 'symbol',
      source: 'markers',
      filter: ['==', ['get', 'showLabel'], 1],
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
    id.startsWith('marker-') ||
    id.startsWith('route-line-') ||
    id.startsWith('route-head-') ||
    id.startsWith('route-vehicle-') ||
    false
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
