import type { StyleSpecification } from 'maplibre-gl';

/**
 * Deterministic offline basemap: Natural Earth 110m countries + graticule,
 * no remote tiles. Removes tile-network flakiness from the render-pipeline
 * spike. Rich vector-tile styles (OpenFreeMap/MapTiler) arrive in Phase 1.
 */
export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'mapmotion-spike',
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      countries: { type: 'geojson', data: '/countries.geojson' },
      graticule: { type: 'geojson', data: buildGraticule() },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0e1726' } },
      {
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        paint: { 'line-color': '#1c2a42', 'line-width': 0.6 },
      },
      {
        id: 'country-fill',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': '#1f3550' },
      },
      {
        id: 'country-line',
        type: 'line',
        source: 'countries',
        paint: { 'line-color': '#3d5a7e', 'line-width': 0.8 },
      },
    ],
  };
}

function buildGraticule(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lng = -180; lng <= 180; lng += 10) {
    const coords: [number, number][] = [];
    for (let lat = -85; lat <= 85; lat += 2) coords.push([lng, lat]);
    features.push(line(coords));
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    const coords: [number, number][] = [];
    for (let lng = -180; lng <= 180; lng += 2) coords.push([lng, lat]);
    features.push(line(coords));
  }
  return { type: 'FeatureCollection', features };
}

function line(coordinates: [number, number][]): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
}
