'use client';

import {
  clusterPhotos,
  isHeic,
  readExif,
  type LngLat,
  type Photo,
  type PhotoCluster,
} from '@mapmotion/engine';

/**
 * Turning a folder of photos into a trip.
 *
 * This is the feature the whole video product is for: someone went
 * somewhere, took two hundred photos, and wants a map video of it. Every
 * other import path asks them to retype what the photos already know.
 *
 * Photos never leave the browser. Only the header of each file is read, and
 * the thumbnails are drawn locally — same posture as GPX import, and the
 * right one for a folder of somebody's holiday.
 */

/**
 * EXIF lives in the first APP1 segment, which is near the start of the file.
 * Reading 128KB rather than a 12MB photo is the difference between a folder
 * import taking a second and taking a minute.
 */
const HEADER_BYTES = 128 * 1024;

/** Pin images are drawn small; anything larger is wasted memory. */
const THUMB_PX = 160;

export interface ImportedPhotos {
  stops: { name: string; coordinate: LngLat }[];
  /** Data-URL thumbnail per stop, for use as the marker image. */
  thumbnails: (string | null)[];
  clusters: PhotoCluster[];
  /** How the import went, for an honest summary rather than a silent drop. */
  summary: {
    total: number;
    located: number;
    noGps: number;
    heic: number;
    unreadable: number;
  };
}

export interface ImportOptions {
  radiusMeters?: number;
  maxStops?: number;
  /** Resolve a coordinate to a place name. Returns null when nothing is near. */
  nameFor?: (coordinate: LngLat) => Promise<string | null> | string | null;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Read a folder of photos into stops.
 *
 * Never throws for a bad file: one unreadable photo out of two hundred must
 * not lose the other hundred and ninety-nine, so failures are counted and
 * reported instead.
 */
export async function importPhotos(
  files: readonly File[],
  opts: ImportOptions = {},
): Promise<ImportedPhotos> {
  const summary = { total: files.length, located: 0, noGps: 0, heic: 0, unreadable: 0 };
  const located: Array<{ photo: Photo; file: File }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    opts.onProgress?.(i, files.length);
    try {
      const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
      if (isHeic(head)) {
        summary.heic++;
        continue;
      }
      const meta = readExif(head);
      if (!meta.coordinate) {
        summary.noGps++;
        continue;
      }
      summary.located++;
      located.push({
        photo: {
          name: file.name,
          coordinate: meta.coordinate,
          takenAtMs: meta.takenAtMs,
          id: `${file.name}:${file.size}`,
        },
        file,
      });
    } catch {
      summary.unreadable++;
    }
    // Yield so a 200-photo folder doesn't freeze the tab.
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  opts.onProgress?.(files.length, files.length);

  const clusters = clusterPhotos(
    located.map((l) => l.photo),
    { radiusMeters: opts.radiusMeters, maxStops: opts.maxStops },
  );

  const byId = new Map(located.map((l) => [l.photo.id!, l.file]));
  const stops: ImportedPhotos['stops'] = [];
  const thumbnails: (string | null)[] = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    const named = await opts.nameFor?.(cluster.coordinate);
    stops.push({
      name: named || fallbackName(cluster, i),
      coordinate: [...cluster.coordinate] as LngLat,
    });
    const file = byId.get(cluster.photos[0]?.id ?? '');
    thumbnails.push(file ? await thumbnail(file) : null);
  }

  return { stops, thumbnails, clusters, summary };
}

/**
 * A name for a place we couldn't resolve.
 *
 * The date is more use than "Stop 4": a person scanning the list recognises
 * "12 Jul" as the day they were somewhere, and can retype the name once.
 */
function fallbackName(cluster: PhotoCluster, index: number): string {
  if (cluster.takenAtMs !== null) {
    const d = new Date(cluster.takenAtMs);
    return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
  }
  return `Stop ${index + 1}`;
}

/**
 * Square-cropped thumbnail as a data URL.
 *
 * `createImageBitmap` rather than an <img> element: it decodes off the main
 * thread and, importantly, applies the EXIF orientation when asked, so
 * portrait photos from a phone don't end up sideways on the map.
 */
export async function thumbnail(file: File, size = THUMB_PX): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) return null;
    // Circular, with a ring. A square photo on a map reads as a UI element;
    // a round one with a border reads as a pin, which is what it is.
    const r = size / 2;
    g.save();
    g.beginPath();
    g.arc(r, r, r - 4, 0, Math.PI * 2);
    g.closePath();
    g.clip();
    // Centre crop, so a wide landscape shot doesn't become a letterboxed pin.
    g.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    g.restore();
    g.lineWidth = 4;
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.arc(r, r, r - 2, 0, Math.PI * 2);
    g.stroke();
    bitmap.close();
    // PNG, not JPEG: the corners outside the circle must stay transparent.
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** Files a photo import should even attempt. */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|tiff?|heic|heif|png)$/i.test(file.name);
}

/** One sentence describing what happened, or null when it all just worked. */
export function summarise(summary: ImportedPhotos['summary']): string | null {
  const parts: string[] = [];
  if (summary.noGps) parts.push(`${summary.noGps} without location`);
  if (summary.heic) parts.push(`${summary.heic} HEIC (unsupported)`);
  if (summary.unreadable) parts.push(`${summary.unreadable} unreadable`);
  if (parts.length === 0) return null;
  return `Used ${summary.located} of ${summary.total} photos — skipped ${parts.join(', ')}.`;
}
