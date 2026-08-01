import type { LngLat } from './types';
import { distanceMeters } from './geo';

/**
 * EXIF GPS and capture time, read from raw bytes.
 *
 * Written rather than pulled in as a dependency for one reason: it can then
 * be a pure function over a Uint8Array, which means it is unit-testable in
 * Node against files built byte by byte. "Does this read my holiday photos"
 * is otherwise a question you can only answer by trying it on holiday photos.
 *
 * Scope is deliberately four tags — GPS position, capture time, orientation
 * and camera model. This is not a general metadata library.
 *
 * SECURITY: every offset in an EXIF file is attacker-controlled. Each read
 * below is bounds-checked, IFD traversal is depth- and count-limited, and
 * malformed input returns empty metadata rather than throwing.
 */

export interface PhotoMeta {
  /** Position from the GPS IFD, or null when the photo has none. */
  coordinate: LngLat | null;
  /**
   * Capture time in ms since the epoch, or null.
   *
   * Prefers GPSDateStamp/GPSTimeStamp, which are genuinely UTC.
   * DateTimeOriginal has no timezone at all — it is wall-clock time wherever
   * the photographer was standing — so it is parsed as UTC and used only as
   * a fallback. That is wrong by up to a day's fraction, and it does not
   * matter here: the only thing capture time is used for is ORDERING photos
   * from one trip, and a constant offset preserves order.
   */
  takenAtMs: number | null;
  /** EXIF orientation, 1–8. 1 when absent. */
  orientation: number;
  make?: string;
  model?: string;
}

export const EMPTY_META: PhotoMeta = {
  coordinate: null,
  takenAtMs: null,
  orientation: 1,
};

// TIFF tag numbers we care about.
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

// GPS IFD tags.
const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;
const GPS_DATE = 0x001d;
const GPS_TIME = 0x0007;

/** Bytes per TIFF component type, indexed by type number. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** No real IFD has this many entries; anything more is corrupt or hostile. */
const MAX_ENTRIES = 512;

interface Reader {
  view: DataView;
  /** Offset of the TIFF header, which all IFD offsets are relative to. */
  base: number;
  little: boolean;
  length: number;
}

/**
 * Parse EXIF from a JPEG or a bare TIFF.
 *
 * HEIC (the iPhone default) is not handled: its EXIF lives inside an
 * ISOBMFF item and needs a box parser. Callers should detect it and say so
 * — silently returning "no GPS" for the most common phone format would be
 * the worst possible failure.
 */
export function readExif(bytes: Uint8Array): PhotoMeta {
  try {
    const tiffStart = findTiffHeader(bytes);
    if (tiffStart < 0) return { ...EMPTY_META };

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const byteOrder = view.getUint16(tiffStart, false);
    const little = byteOrder === 0x4949;
    if (!little && byteOrder !== 0x4d4d) return { ...EMPTY_META };

    const magic = view.getUint16(tiffStart + 2, little);
    if (magic !== 42) return { ...EMPTY_META };

    const r: Reader = { view, base: tiffStart, little, length: bytes.byteLength };
    const ifd0Offset = view.getUint32(tiffStart + 4, little);

    const meta: PhotoMeta = { ...EMPTY_META };
    const ifd0 = readIfd(r, ifd0Offset);
    if (!ifd0) return meta;

    meta.orientation = normaliseOrientation(numberValue(r, ifd0.get(TAG_ORIENTATION)));
    meta.make = stringValue(r, ifd0.get(TAG_MAKE));
    meta.model = stringValue(r, ifd0.get(TAG_MODEL));

    const exifOffset = numberValue(r, ifd0.get(TAG_EXIF_IFD));
    const exifIfd = exifOffset !== null ? readIfd(r, exifOffset) : null;

    const gpsOffset = numberValue(r, ifd0.get(TAG_GPS_IFD));
    const gpsIfd = gpsOffset !== null ? readIfd(r, gpsOffset) : null;

    if (gpsIfd) {
      meta.coordinate = readGpsCoordinate(r, gpsIfd);
      meta.takenAtMs = readGpsTime(r, gpsIfd);
    }

    if (meta.takenAtMs === null && exifIfd) {
      meta.takenAtMs =
        parseExifDate(stringValue(r, exifIfd.get(TAG_DATETIME_ORIGINAL))) ??
        parseExifDate(stringValue(r, exifIfd.get(TAG_DATETIME_DIGITIZED)));
    }

    return meta;
  } catch {
    // Truncated file, bogus offsets, hostile input. A photo we can't read is
    // a photo we skip, never a crash that loses the other 199.
    return { ...EMPTY_META };
  }
}

/** True for a file whose EXIF this parser cannot reach (HEIC/HEIF). */
export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // ISOBMFF: [size][ftyp][major brand]
  if (
    bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70
  ) {
    return false;
  }
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  return ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'mif1', 'msf1'].includes(brand);
}

/** Offset of the TIFF header inside a JPEG APP1 segment, or of a bare TIFF. */
function findTiffHeader(bytes: Uint8Array): number {
  // Bare TIFF.
  if (
    bytes.length > 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))
  ) {
    return 0;
  }

  // JPEG: walk the marker segments looking for APP1/Exif.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return -1;

  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      // Not on a marker boundary — a padded or damaged file. Resync rather
      // than giving up; scanners emit these constantly.
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    // Standalone markers with no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan — image data follows, no more metadata worth walking.
    if (marker === 0xda || marker === 0xd9) return -1;

    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2) return -1;

    if (marker === 0xe1 && i + 10 <= bytes.length) {
      const tag = String.fromCharCode(
        bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!,
      );
      // "Exif\0\0" then the TIFF header.
      if (tag === 'Exif' && bytes[i + 8] === 0) return i + 10;
    }
    i += 2 + length;
  }
  return -1;
}

interface Entry {
  type: number;
  count: number;
  /** Offset of the value, already resolved through the inline/pointer rule. */
  valueOffset: number;
}

/**
 * Read one IFD into a tag map.
 *
 * Returns null on anything that doesn't fit inside the file, so a corrupt
 * offset can't send the parser reading arbitrary memory.
 */
function readIfd(r: Reader, offset: number): Map<number, Entry> | null {
  const start = r.base + offset;
  if (offset < 0 || start + 2 > r.length) return null;

  const count = r.view.getUint16(start, r.little);
  if (count === 0 || count > MAX_ENTRIES) return null;
  if (start + 2 + count * 12 > r.length) return null;

  const out = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const at = start + 2 + i * 12;
    const tag = r.view.getUint16(at, r.little);
    const type = r.view.getUint16(at + 2, r.little);
    const n = r.view.getUint32(at + 4, r.little);
    const size = (TYPE_SIZE[type] ?? 0) * n;
    if (size === 0 || n > 1_000_000) continue;

    // Values of four bytes or fewer are stored inline in the entry itself;
    // anything larger is a pointer relative to the TIFF header.
    const valueOffset =
      size <= 4 ? at + 8 : r.base + r.view.getUint32(at + 8, r.little);
    if (valueOffset < 0 || valueOffset + size > r.length) continue;

    out.set(tag, { type, count: n, valueOffset });
  }
  return out;
}

function numberValue(r: Reader, e: Entry | undefined): number | null {
  if (!e) return null;
  return readComponent(r, e, 0);
}

function readComponent(r: Reader, e: Entry, index: number): number | null {
  const size = TYPE_SIZE[e.type] ?? 0;
  if (!size || index >= e.count) return null;
  const at = e.valueOffset + index * size;
  if (at + size > r.length) return null;

  switch (e.type) {
    case 1: return r.view.getUint8(at);
    case 3: return r.view.getUint16(at, r.little);
    case 4: return r.view.getUint32(at, r.little);
    case 5: {
      const num = r.view.getUint32(at, r.little);
      const den = r.view.getUint32(at + 4, r.little);
      return den === 0 ? 0 : num / den;
    }
    case 9: return r.view.getInt32(at, r.little);
    case 10: {
      const num = r.view.getInt32(at, r.little);
      const den = r.view.getInt32(at + 4, r.little);
      return den === 0 ? 0 : num / den;
    }
    default: return null;
  }
}

function stringValue(r: Reader, e: Entry | undefined): string | undefined {
  if (!e || (e.type !== 2 && e.type !== 7)) return undefined;
  let out = '';
  for (let i = 0; i < e.count; i++) {
    const at = e.valueOffset + i;
    if (at >= r.length) break;
    const c = r.view.getUint8(at);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out.trim() || undefined;
}

/** Degrees, minutes, seconds -> signed decimal degrees. */
function readGpsCoordinate(r: Reader, gps: Map<number, Entry>): LngLat | null {
  const lat = dms(r, gps.get(GPS_LAT));
  const lon = dms(r, gps.get(GPS_LON));
  if (lat === null || lon === null) return null;

  const latRef = (stringValue(r, gps.get(GPS_LAT_REF)) ?? 'N').toUpperCase();
  const lonRef = (stringValue(r, gps.get(GPS_LON_REF)) ?? 'E').toUpperCase();

  const latitude = latRef === 'S' ? -lat : lat;
  const longitude = lonRef === 'W' ? -lon : lon;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  // A camera with no fix writes 0/0. That is in the Gulf of Guinea, and a
  // pin there is far more confusing than no pin at all.
  if (latitude === 0 && longitude === 0) return null;

  return [longitude, latitude];
}

function dms(r: Reader, e: Entry | undefined): number | null {
  if (!e || e.count < 3) return null;
  const d = readComponent(r, e, 0);
  const m = readComponent(r, e, 1);
  const s = readComponent(r, e, 2);
  if (d === null || m === null || s === null) return null;
  return d + m / 60 + s / 3600;
}

/** GPSDateStamp is "YYYY:MM:DD" and GPSTimeStamp is three rationals, in UTC. */
function readGpsTime(r: Reader, gps: Map<number, Entry>): number | null {
  const date = stringValue(r, gps.get(GPS_DATE));
  if (!date) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})$/.exec(date.trim());
  if (!m) return null;

  const time = gps.get(GPS_TIME);
  const h = time ? readComponent(r, time, 0) ?? 0 : 0;
  const min = time ? readComponent(r, time, 1) ?? 0 : 0;
  const sec = time ? readComponent(r, time, 2) ?? 0 : 0;

  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Math.floor(h), Math.floor(min), Math.floor(sec),
  );
  return Number.isFinite(ms) ? ms : null;
}

/** "YYYY:MM:DD HH:MM:SS" — EXIF's own format, with colons in the date. */
function parseExifDate(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
  return Number.isFinite(ms) ? ms : null;
}

function normaliseOrientation(v: number | null): number {
  return v !== null && v >= 1 && v <= 8 ? Math.round(v) : 1;
}

// ---------------------------------------------------------------------------
// Turning a folder of photos into a trip
// ---------------------------------------------------------------------------

export interface Photo {
  /** File name, used to name the stop when nothing better is available. */
  name: string;
  coordinate: LngLat;
  takenAtMs: number | null;
  /** Opaque handle the caller uses to find its thumbnail again. */
  id?: string;
}

export interface PhotoCluster {
  /** Mean position of the photos in the cluster. */
  coordinate: LngLat;
  photos: Photo[];
  /** Earliest capture time in the cluster, for ordering. */
  takenAtMs: number | null;
}

export interface ClusterOptions {
  /**
   * Photos closer together than this join one stop. 150m is roughly "the
   * same place" for a traveller — a cathedral and its square, not two
   * neighbourhoods.
   */
  radiusMeters?: number;
  /** Never produce more stops than this, however spread out the photos. */
  maxStops?: number;
}

/**
 * Group photos into stops, in the order they were taken.
 *
 * Someone with 200 holiday photos has maybe 20 places. Plotting 200 markers
 * produces an unreadable map and a video that takes ten minutes; plotting one
 * per place produces exactly the trip they took. This is the difference
 * between the feature working and it technically working.
 *
 * The clustering is sequential rather than spatial-only, so a trip that
 * returns to the same city twice gets two stops — because that is what
 * happened, and a map that silently merges them tells the wrong story.
 */
export function clusterPhotos(
  photos: readonly Photo[],
  opts: ClusterOptions = {},
): PhotoCluster[] {
  const radius = opts.radiusMeters ?? 150;
  const maxStops = Math.max(2, opts.maxStops ?? 40);

  const ordered = [...photos].sort(byTimeThenName);

  const clusters: PhotoCluster[] = [];
  for (const photo of ordered) {
    const current = clusters[clusters.length - 1];
    if (current && distanceMeters(current.coordinate, photo.coordinate) <= radius) {
      current.photos.push(photo);
      current.coordinate = meanCoordinate(current.photos);
      if (current.takenAtMs === null) current.takenAtMs = photo.takenAtMs;
      continue;
    }
    clusters.push({
      coordinate: [...photo.coordinate] as LngLat,
      photos: [photo],
      takenAtMs: photo.takenAtMs,
    });
  }

  return clusters.length > maxStops ? thinTo(clusters, maxStops) : clusters;
}

/**
 * Reduce to `limit` stops by repeatedly merging the closest neighbouring
 * pair.
 *
 * Dropping the smallest clusters instead would delete places the user
 * actually visited. Merging neighbours keeps every location represented, just
 * at a coarser grain — the route still goes everywhere it went.
 */
function thinTo(clusters: PhotoCluster[], limit: number): PhotoCluster[] {
  const out = [...clusters];
  while (out.length > limit) {
    let bestIndex = 0;
    let bestGap = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const gap = distanceMeters(out[i]!.coordinate, out[i + 1]!.coordinate);
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    const a = out[bestIndex]!;
    const b = out[bestIndex + 1]!;
    const merged: PhotoCluster = {
      photos: [...a.photos, ...b.photos],
      coordinate: meanCoordinate([...a.photos, ...b.photos]),
      takenAtMs: a.takenAtMs ?? b.takenAtMs,
    };
    out.splice(bestIndex, 2, merged);
  }
  return out;
}

/**
 * Photos with a time sort by it; photos without keep their given order after
 * the timed ones, by name. Mixing a timestamped photo and an untimed one
 * arbitrarily would reorder someone's trip.
 */
function byTimeThenName(a: Photo, b: Photo): number {
  if (a.takenAtMs !== null && b.takenAtMs !== null) return a.takenAtMs - b.takenAtMs;
  if (a.takenAtMs !== null) return -1;
  if (b.takenAtMs !== null) return 1;
  return a.name.localeCompare(b.name);
}

function meanCoordinate(photos: readonly Photo[]): LngLat {
  let lng = 0;
  let lat = 0;
  for (const p of photos) {
    lng += p.coordinate[0];
    lat += p.coordinate[1];
  }
  return [lng / photos.length, lat / photos.length];
}
