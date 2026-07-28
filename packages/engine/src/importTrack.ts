import { XMLParser } from 'fast-xml-parser';
import type { LngLat } from './types';
import type { TripStop } from './compile';

/**
 * GPX / KML import.
 *
 * Pure functions over a string, with no DOM dependency, so the same parser
 * runs in the browser, in Node tests, and (later) server-side. Real files
 * from Strava, Garmin, AllTrails and Google Earth vary a lot in shape, so
 * the parser is deliberately forgiving: it accepts tracks, routes and bare
 * waypoints, tolerates missing namespaces and single-vs-array children, and
 * skips malformed points rather than throwing.
 */

export interface ImportedTrack {
  /** Track/route name from the file, if it had one. */
  name: string | null;
  /** The full path, in file order. Empty if the file had only waypoints. */
  track: LngLat[];
  /** Named points of interest (GPX <wpt>, KML Placemark/Point). */
  waypoints: TripStop[];
  /** Elevations in metres, parallel to `track` where present. */
  elevations: number[];
  format: 'gpx' | 'kml';
}

export class TrackImportError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Namespace prefixes (gpx:, ns3:) vary by exporter; strip them so lookups
  // are uniform.
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
});

export function importTrack(text: string, filename = ''): ImportedTrack {
  const trimmed = text.trim();
  if (!trimmed) throw new TrackImportError('File is empty');

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new TrackImportError('File is not valid XML');
  }

  if (doc.gpx) return parseGpx(doc.gpx as Record<string, unknown>);
  if (doc.kml) return parseKml(doc.kml as Record<string, unknown>);

  const hint = filename ? ` (${filename})` : '';
  throw new TrackImportError(`Not a GPX or KML file${hint}`);
}

// ---------------------------------------------------------------- GPX

function parseGpx(gpx: Record<string, unknown>): ImportedTrack {
  const track: LngLat[] = [];
  const elevations: number[] = [];
  let name: string | null = null;

  for (const trk of arr(gpx.trk)) {
    const t = trk as Record<string, unknown>;
    name ??= str(t.name);
    // A track may be split into multiple segments (pauses, signal loss);
    // they form one continuous path for our purposes.
    for (const seg of arr(t.trkseg)) {
      for (const pt of arr((seg as Record<string, unknown>).trkpt)) {
        pushPoint(pt as Record<string, unknown>, track, elevations);
      }
    }
  }

  // Routes (<rte>) are planned rather than recorded, but animate the same.
  if (track.length === 0) {
    for (const rte of arr(gpx.rte)) {
      const r = rte as Record<string, unknown>;
      name ??= str(r.name);
      for (const pt of arr(r.rtept)) {
        pushPoint(pt as Record<string, unknown>, track, elevations);
      }
    }
  }

  const waypoints: TripStop[] = [];
  for (const wpt of arr(gpx.wpt)) {
    const w = wpt as Record<string, unknown>;
    const c = coord(w);
    if (c) waypoints.push({ name: str(w.name) ?? `Point ${waypoints.length + 1}`, coordinate: c });
  }

  if (track.length === 0 && waypoints.length === 0) {
    throw new TrackImportError('No track, route or waypoints found in this GPX');
  }
  return { name, track, waypoints, elevations, format: 'gpx' };
}

function pushPoint(
  pt: Record<string, unknown>,
  track: LngLat[],
  elevations: number[],
): void {
  const c = coord(pt);
  if (!c) return;
  track.push(c);
  const ele = num(pt.ele);
  elevations.push(ele ?? Number.NaN);
}

function coord(node: Record<string, unknown>): LngLat | null {
  const lat = num(node['@lat']);
  const lon = num(node['@lon'] ?? node['@lng']);
  if (lat === null || lon === null) return null;
  if (!inRange(lon, lat)) return null;
  return [lon, lat];
}

// ---------------------------------------------------------------- KML

function parseKml(kml: Record<string, unknown>): ImportedTrack {
  const track: LngLat[] = [];
  const elevations: number[] = [];
  const waypoints: TripStop[] = [];
  let name: string | null = null;

  // Placemarks can nest arbitrarily deep inside Folders/Documents.
  const placemarks: Record<string, unknown>[] = [];
  collect(kml, 'Placemark', placemarks);

  for (const pm of placemarks) {
    const pmName = str(pm.name);

    const lineStrings: Record<string, unknown>[] = [];
    collect(pm, 'LineString', lineStrings);
    for (const ls of lineStrings) {
      const pts = parseKmlCoordinates(str(ls.coordinates));
      if (pts.length) {
        name ??= pmName;
        for (const p of pts) {
          track.push([p[0], p[1]]);
          elevations.push(p[2]);
        }
      }
    }

    const points: Record<string, unknown>[] = [];
    collect(pm, 'Point', points);
    for (const p of points) {
      const pts = parseKmlCoordinates(str(p.coordinates));
      if (pts.length) {
        waypoints.push({
          name: pmName ?? `Point ${waypoints.length + 1}`,
          coordinate: [pts[0]![0], pts[0]![1]],
        });
      }
    }
  }

  if (track.length === 0 && waypoints.length === 0) {
    throw new TrackImportError('No LineString or Point found in this KML');
  }
  return { name, track, waypoints, elevations, format: 'kml' };
}

/** KML packs coordinates as whitespace-separated "lng,lat[,alt]" triples. */
function parseKmlCoordinates(raw: string | null): Array<[number, number, number]> {
  if (!raw) return [];
  const out: Array<[number, number, number]> = [];
  for (const tuple of raw.trim().split(/\s+/)) {
    const parts = tuple.split(',');
    if (parts.length < 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    const alt = parts.length > 2 ? Number(parts[2]) : Number.NaN;
    if (!inRange(lng, lat)) continue;
    out.push([lng, lat, Number.isFinite(alt) ? alt : Number.NaN]);
  }
  return out;
}

/**
 * Find every node with the given tag name, at any depth.
 *
 * Iterative rather than recursive: KML nests Folders arbitrarily (Google
 * Earth exports and hand-built files both do it), and recursion would put
 * that depth on the call stack. The node budget is a backstop against
 * pathological input, not a structural limit.
 */
function collect(root: unknown, tag: string, out: Record<string, unknown>[]): void {
  const stack: unknown[] = [root];
  let budget = 200_000;

  while (stack.length && budget-- > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === tag) {
        for (const v of arr(value)) {
          if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
        }
      } else {
        for (const v of arr(value)) {
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- utils

function arr(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    return t === undefined ? null : String(t).trim() || null;
  }
  const s = String(v).trim();
  return s || null;
}

function inRange(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}
