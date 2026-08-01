import { describe, expect, it } from 'vitest';
import { clusterPhotos, isHeic, readExif, type Photo } from '../src';

/**
 * Build a JPEG with a real EXIF block, byte by byte.
 *
 * Fixtures rather than checked-in photos, because a fixture can be varied:
 * big-endian, missing GPS, a zero fix, a corrupt pointer. Those are the cases
 * that break EXIF parsers, and none of them appear in a photo you happen to
 * have lying around.
 */
interface TagSpec {
  tag: number;
  type: number;
  values: number[] | string;
}

function buildJpeg(opts: {
  little?: boolean;
  ifd0?: TagSpec[];
  exif?: TagSpec[];
  gps?: TagSpec[];
  /** Corrupt the GPS IFD pointer to something past the end of the file. */
  wildGpsPointer?: boolean;
  /** Emit a bare TIFF instead of wrapping in JPEG. */
  bareTiff?: boolean;
}): Uint8Array {
  const little = opts.little ?? true;
  const chunks: number[] = [];
  const w8 = (v: number) => chunks.push(v & 0xff);
  const w16 = (v: number) => {
    if (little) { w8(v); w8(v >> 8); } else { w8(v >> 8); w8(v); }
  };
  const w32 = (v: number) => {
    if (little) { w8(v); w8(v >> 8); w8(v >> 16); w8(v >> 24); }
    else { w8(v >> 24); w8(v >> 16); w8(v >> 8); w8(v); }
  };

  // TIFF header.
  if (little) { w8(0x49); w8(0x49); } else { w8(0x4d); w8(0x4d); }
  w16(42);
  w32(8); // IFD0 at offset 8

  const sizeOf = (t: TagSpec) =>
    typeof t.values === 'string'
      ? t.values.length + 1
      : t.values.length * (t.type === 5 || t.type === 10 ? 8 : t.type === 3 ? 2 : 4);

  const ifd0 = [...(opts.ifd0 ?? [])];
  const exif = opts.exif ?? [];
  const gps = opts.gps ?? [];

  // Lay out: IFD0, then EXIF IFD, then GPS IFD, then the overflow heap.
  const ifd0Count = ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifOffset = 8 + ifd0Size;
  const exifSize = exif.length ? 2 + exif.length * 12 + 4 : 0;
  const gpsOffset = exifOffset + exifSize;
  const gpsSize = gps.length ? 2 + gps.length * 12 + 4 : 0;
  let heap = gpsOffset + gpsSize;

  const heapBytes: number[] = [];
  const writeIfd = (tags: TagSpec[], extra: Array<{ tag: number; value: number }>) => {
    w16(tags.length + extra.length);
    const all = [
      ...tags.map((t) => ({ kind: 'tag' as const, t })),
      ...extra.map((e) => ({ kind: 'ptr' as const, e })),
    ].sort((a, b) => (a.kind === 'tag' ? a.t.tag : a.e.tag) - (b.kind === 'tag' ? b.t.tag : b.e.tag));

    for (const item of all) {
      if (item.kind === 'ptr') {
        w16(item.e.tag);
        w16(4);
        w32(1);
        w32(item.e.value);
        continue;
      }
      const t = item.t;
      const count = typeof t.values === 'string' ? t.values.length + 1 : t.values.length;
      w16(t.tag);
      w16(t.type);
      w32(count);
      const size = sizeOf(t);
      if (size <= 4) {
        const inline: number[] = [];
        if (typeof t.values === 'string') {
          for (const ch of t.values) inline.push(ch.charCodeAt(0));
          inline.push(0);
        } else {
          for (const v of t.values) {
            if (t.type === 3) { inline.push(v & 0xff, (v >> 8) & 0xff); }
            else inline.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
          }
        }
        while (inline.length < 4) inline.push(0);
        // Inline values follow the file's byte order for each component, but
        // the four bytes themselves are written in order.
        if (!little && t.type === 3) {
          chunks.push(inline[1]!, inline[0]!, inline[3]!, inline[2]!);
        } else if (!little && (t.type === 4 || t.type === 9)) {
          chunks.push(inline[3]!, inline[2]!, inline[1]!, inline[0]!);
        } else {
          chunks.push(inline[0]!, inline[1]!, inline[2]!, inline[3]!);
        }
      } else {
        w32(heap + heapBytes.length);
        if (typeof t.values === 'string') {
          for (const ch of t.values) heapBytes.push(ch.charCodeAt(0));
          heapBytes.push(0);
        } else {
          for (const v of t.values) {
            const push32 = (x: number) => {
              if (little) heapBytes.push(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff);
              else heapBytes.push((x >>> 24) & 0xff, (x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff);
            };
            if (t.type === 5 || t.type === 10) {
              // Rationals are encoded as value*10000 / 10000 so fractional
              // seconds survive the fixture.
              push32(Math.round(v * 10000));
              push32(10000);
            } else push32(v);
          }
        }
      }
    }
    w32(0); // no next IFD
  };

  writeIfd(ifd0, [
    ...(exif.length ? [{ tag: 0x8769, value: exifOffset }] : []),
    ...(gps.length ? [{ tag: 0x8825, value: opts.wildGpsPointer ? 0x7fff_0000 : gpsOffset }] : []),
  ]);
  if (exif.length) writeIfd(exif, []);
  if (gps.length) writeIfd(gps, []);
  chunks.push(...heapBytes);

  const tiff = Uint8Array.from(chunks);
  if (opts.bareTiff) return tiff;

  const app1Len = 2 + 6 + tiff.length;
  const out = new Uint8Array(4 + app1Len + 2);
  let i = 0;
  out[i++] = 0xff; out[i++] = 0xd8; // SOI
  out[i++] = 0xff; out[i++] = 0xe1; // APP1
  out[i++] = (app1Len >> 8) & 0xff;
  out[i++] = app1Len & 0xff;
  for (const ch of 'Exif') out[i++] = ch.charCodeAt(0);
  out[i++] = 0; out[i++] = 0;
  out.set(tiff, i);
  i += tiff.length;
  out[i++] = 0xff; out[i++] = 0xd9; // EOI
  return out.subarray(0, i);
}

/** Bangkok: 13°45'22.7"N, 100°30'6.5"E */
const BKK_GPS: TagSpec[] = [
  { tag: 0x0001, type: 2, values: 'N' },
  { tag: 0x0002, type: 5, values: [13, 45, 22.68] },
  { tag: 0x0003, type: 2, values: 'E' },
  { tag: 0x0004, type: 5, values: [100, 30, 6.48] },
];

describe('readExif — GPS', () => {
  it('reads a coordinate from a little-endian JPEG', () => {
    const meta = readExif(buildJpeg({ gps: BKK_GPS }));
    expect(meta.coordinate).not.toBeNull();
    expect(meta.coordinate![0]).toBeCloseTo(100.5018, 3);
    expect(meta.coordinate![1]).toBeCloseTo(13.7563, 3);
  });

  it('reads a coordinate from a big-endian JPEG', () => {
    // Motorola byte order is what most DSLRs write; getting it wrong yields
    // coordinates in the wrong hemisphere rather than an error.
    const meta = readExif(buildJpeg({ little: false, gps: BKK_GPS }));
    expect(meta.coordinate![0]).toBeCloseTo(100.5018, 3);
    expect(meta.coordinate![1]).toBeCloseTo(13.7563, 3);
  });

  it('applies S and W hemisphere references', () => {
    const meta = readExif(
      buildJpeg({
        gps: [
          { tag: 0x0001, type: 2, values: 'S' },
          { tag: 0x0002, type: 5, values: [33, 51, 7.9] },
          { tag: 0x0003, type: 2, values: 'W' },
          { tag: 0x0004, type: 5, values: [70, 39, 0] },
        ],
      }),
    );
    expect(meta.coordinate![1]).toBeLessThan(0);
    expect(meta.coordinate![0]).toBeLessThan(0);
    expect(meta.coordinate![1]).toBeCloseTo(-33.8522, 3);
    expect(meta.coordinate![0]).toBeCloseTo(-70.65, 3);
  });

  it('reads a bare TIFF as well as a JPEG', () => {
    const meta = readExif(buildJpeg({ gps: BKK_GPS, bareTiff: true }));
    expect(meta.coordinate![1]).toBeCloseTo(13.7563, 3);
  });

  it('rejects a null-island fix rather than pinning the Gulf of Guinea', () => {
    // A camera with no lock writes 0/0. A marker there is worse than none.
    const meta = readExif(
      buildJpeg({
        gps: [
          { tag: 0x0001, type: 2, values: 'N' },
          { tag: 0x0002, type: 5, values: [0, 0, 0] },
          { tag: 0x0003, type: 2, values: 'E' },
          { tag: 0x0004, type: 5, values: [0, 0, 0] },
        ],
      }),
    );
    expect(meta.coordinate).toBeNull();
  });

  it('returns null for a photo with no GPS at all', () => {
    const meta = readExif(
      buildJpeg({ exif: [{ tag: 0x9003, type: 2, values: '2026:07:04 11:22:33' }] }),
    );
    expect(meta.coordinate).toBeNull();
    expect(meta.takenAtMs).not.toBeNull();
  });
});

describe('readExif — time', () => {
  it('prefers the GPS timestamp, which is genuinely UTC', () => {
    const meta = readExif(
      buildJpeg({
        gps: [
          ...BKK_GPS,
          { tag: 0x001d, type: 2, values: '2026:07:04' },
          { tag: 0x0007, type: 5, values: [11, 22, 33] },
        ],
        exif: [{ tag: 0x9003, type: 2, values: '2020:01:01 00:00:00' }],
      }),
    );
    expect(meta.takenAtMs).toBe(Date.UTC(2026, 6, 4, 11, 22, 33));
  });

  it('falls back to DateTimeOriginal', () => {
    const meta = readExif(
      buildJpeg({ exif: [{ tag: 0x9003, type: 2, values: '2026:07:04 11:22:33' }] }),
    );
    expect(meta.takenAtMs).toBe(Date.UTC(2026, 6, 4, 11, 22, 33));
  });

  it('falls back again to DateTimeDigitized', () => {
    const meta = readExif(
      buildJpeg({ exif: [{ tag: 0x9004, type: 2, values: '2026:07:04 08:00:00' }] }),
    );
    expect(meta.takenAtMs).toBe(Date.UTC(2026, 6, 4, 8, 0, 0));
  });

  it('returns null rather than a wrong date for a malformed stamp', () => {
    const meta = readExif(
      buildJpeg({ exif: [{ tag: 0x9003, type: 2, values: 'not a date' }] }),
    );
    expect(meta.takenAtMs).toBeNull();
  });
});

describe('readExif — camera and orientation', () => {
  it('reads make, model and orientation', () => {
    const meta = readExif(
      buildJpeg({
        ifd0: [
          { tag: 0x010f, type: 2, values: 'Fujifilm' },
          { tag: 0x0110, type: 2, values: 'X100V' },
          { tag: 0x0112, type: 3, values: [6] },
        ],
        gps: BKK_GPS,
      }),
    );
    expect(meta.make).toBe('Fujifilm');
    expect(meta.model).toBe('X100V');
    expect(meta.orientation).toBe(6);
  });

  it('defaults orientation to 1 when absent or nonsense', () => {
    expect(readExif(buildJpeg({ gps: BKK_GPS })).orientation).toBe(1);
    expect(
      readExif(buildJpeg({ ifd0: [{ tag: 0x0112, type: 3, values: [99] }], gps: BKK_GPS }))
        .orientation,
    ).toBe(1);
  });
});

describe('readExif — hostile and broken input', () => {
  it('survives an IFD pointer past the end of the file', () => {
    const meta = readExif(buildJpeg({ gps: BKK_GPS, wildGpsPointer: true }));
    expect(meta.coordinate).toBeNull();
    expect(meta.orientation).toBe(1);
  });

  it('survives truncation at every length', () => {
    const full = buildJpeg({ gps: BKK_GPS, exif: [{ tag: 0x9003, type: 2, values: '2026:07:04 11:22:33' }] });
    for (let cut = 0; cut < full.length; cut += 3) {
      expect(() => readExif(full.subarray(0, cut))).not.toThrow();
    }
  });

  it('returns empty metadata for things that are not images', () => {
    expect(readExif(new Uint8Array(0)).coordinate).toBeNull();
    expect(readExif(Uint8Array.from([1, 2, 3, 4, 5])).coordinate).toBeNull();
    expect(readExif(new TextEncoder().encode('definitely not a photo')).coordinate).toBeNull();
  });

  it('returns empty metadata for a JPEG with no EXIF segment', () => {
    const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    expect(readExif(plain).coordinate).toBeNull();
  });

  it('does not read past the start-of-scan marker', () => {
    // Anything after SOS is compressed image data; a parser that keeps
    // walking will find "markers" in it forever.
    const junk = new Uint8Array(300).fill(0xff);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, ...junk]);
    expect(() => readExif(jpeg)).not.toThrow();
    expect(readExif(jpeg).coordinate).toBeNull();
  });
});

describe('isHeic', () => {
  const ftyp = (brand: string) =>
    Uint8Array.from([
      0, 0, 0, 24,
      ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
      ...brand.split('').map((c) => c.charCodeAt(0)),
    ]);

  it('recognises the iPhone default format', () => {
    expect(isHeic(ftyp('heic'))).toBe(true);
    expect(isHeic(ftyp('mif1'))).toBe(true);
  });

  it('does not mistake a JPEG or an MP4 for HEIC', () => {
    expect(isHeic(buildJpeg({ gps: BKK_GPS }))).toBe(false);
    expect(isHeic(ftyp('isom'))).toBe(false);
    expect(isHeic(new Uint8Array(4))).toBe(false);
  });
});

describe('clusterPhotos', () => {
  const at = (lng: number, lat: number, t: number, name = `p${t}`): Photo => ({
    name,
    coordinate: [lng, lat],
    takenAtMs: t,
  });

  it('merges photos taken in the same place', () => {
    // Three shots of the same square, ~30m apart.
    const clusters = clusterPhotos([
      at(100.5018, 13.7563, 1000),
      at(100.5021, 13.7564, 2000),
      at(100.5019, 13.7561, 3000),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.photos).toHaveLength(3);
  });

  it('keeps distinct places apart', () => {
    const clusters = clusterPhotos([
      at(100.5018, 13.7563, 1000),
      at(139.6917, 35.6895, 2000),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('orders stops by capture time, not by input order', () => {
    const clusters = clusterPhotos([
      at(139.6917, 35.6895, 5000, 'tokyo'),
      at(100.5018, 13.7563, 1000, 'bangkok'),
    ]);
    expect(clusters[0]!.photos[0]!.name).toBe('bangkok');
    expect(clusters[1]!.photos[0]!.name).toBe('tokyo');
  });

  it('gives a returned-to place two stops, because that is what happened', () => {
    // Bangkok -> Tokyo -> Bangkok. Spatial-only clustering would merge the
    // two Bangkok visits and tell the wrong story.
    const clusters = clusterPhotos([
      at(100.5018, 13.7563, 1000),
      at(139.6917, 35.6895, 2000),
      at(100.5018, 13.7563, 3000),
    ]);
    expect(clusters).toHaveLength(3);
  });

  it('respects the radius option', () => {
    const near = [at(100.5018, 13.7563, 1000), at(100.5058, 13.7563, 2000)]; // ~430m
    expect(clusterPhotos(near, { radiusMeters: 150 })).toHaveLength(2);
    expect(clusterPhotos(near, { radiusMeters: 1000 })).toHaveLength(1);
  });

  it('caps the number of stops by merging neighbours, never by dropping them', () => {
    const many = Array.from({ length: 30 }, (_, i) => at(100 + i * 0.1, 13, i * 1000));
    const clusters = clusterPhotos(many, { maxStops: 6 });
    expect(clusters).toHaveLength(6);
    // Every photo must still be represented somewhere.
    const kept = clusters.reduce((n, c) => n + c.photos.length, 0);
    expect(kept).toBe(30);
  });

  it('puts undated photos after dated ones, in name order', () => {
    const clusters = clusterPhotos([
      { name: 'b.jpg', coordinate: [10, 10], takenAtMs: null },
      { name: 'a.jpg', coordinate: [20, 20], takenAtMs: null },
      { name: 'timed.jpg', coordinate: [30, 30], takenAtMs: 500 },
    ]);
    expect(clusters.map((c) => c.photos[0]!.name)).toEqual(['timed.jpg', 'a.jpg', 'b.jpg']);
  });

  it('handles the empty and single-photo cases', () => {
    expect(clusterPhotos([])).toEqual([]);
    expect(clusterPhotos([at(1, 1, 1)])).toHaveLength(1);
  });

  it('reports the earliest time in each cluster', () => {
    const clusters = clusterPhotos([at(100.5018, 13.7563, 1000), at(100.502, 13.7564, 9000)]);
    expect(clusters[0]!.takenAtMs).toBe(1000);
  });
});
