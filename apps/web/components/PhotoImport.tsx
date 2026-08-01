'use client';

import { useCallback, useRef, useState } from 'react';
import type { LngLat } from '@mapmotion/engine';
import {
  importPhotos,
  isImageFile,
  summarise,
  type ImportedPhotos,
} from '../lib/photoImport';

/**
 * Drag in a folder of trip photos; get the trip.
 *
 * The pitch is one drag: the photos already know where and when they were
 * taken, and they are better images of those places than any stock database
 * would give us — they are the reason the video is being made at all.
 */
export function PhotoImport({
  onImport,
  disabled,
}: {
  onImport: (result: ImportedPhotos) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (fileList: FileList | File[] | null) => {
      const files = Array.from(fileList ?? []).filter(isImageFile);
      if (files.length === 0) {
        setError('No images in that drop.');
        return;
      }
      setBusy(true);
      setError(null);
      setNote(null);
      setProgress(0);
      await new Promise((r) => setTimeout(r, 16));

      const result = await importPhotos(files, {
        onProgress: (done, total) => setProgress(total ? done / total : 0),
        nameFor: (coordinate) => resolveName(coordinate),
      });

      setBusy(false);
      if (result.stops.length < 2) {
        setError(
          result.summary.located === 0
            ? locationlessMessage(result.summary)
            : 'Only one location found — a trip needs at least two.',
        );
        return;
      }
      setNote(summarise(result.summary) ?? `${result.stops.length} places from ${result.summary.located} photos.`);
      onImport(result);
    },
    [onImport],
  );

  return (
    <div data-testid="photo-import" style={{ marginTop: 10 }}>
      <div
        data-testid="photo-drop"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void run(e.dataTransfer.files);
        }}
        onClick={() => !busy && inputRef.current?.click()}
        style={{
          border: `1px dashed ${dragging ? '#e8590c' : '#34496b'}`,
          borderRadius: 8,
          padding: '12px 10px',
          textAlign: 'center',
          fontSize: 12,
          cursor: busy ? 'default' : 'pointer',
          background: dragging ? 'rgba(232,89,12,0.08)' : 'transparent',
        }}
      >
        {busy ? (
          <>Reading photos… {Math.round(progress * 100)}%</>
        ) : (
          <>
            Drop your trip photos
            <div style={{ fontSize: 10, opacity: 0.45, marginTop: 3 }}>
              Plots them from their GPS data and uses each as its pin · stays on your device
            </div>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        data-testid="photo-input"
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => void run(e.target.files)}
      />

      {note && (
        <p data-testid="photo-note" style={{ fontSize: 10, opacity: 0.6, margin: '5px 0 0' }}>
          {note}
        </p>
      )}
      {error && (
        <p data-testid="photo-error" style={{ color: '#ffc078', fontSize: 11, margin: '5px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Explain WHY nothing was found, because the three causes have three
 * different fixes and "no photos with location data" helps with none of them.
 */
function locationlessMessage(summary: ImportedPhotos['summary']): string {
  if (summary.heic > 0 && summary.heic >= summary.noGps) {
    return `Those are HEIC files, which browsers can't read metadata from yet. On iPhone: Settings › Camera › Formats › Most Compatible, or share them as JPEG first.`;
  }
  if (summary.noGps > 0) {
    return `None of those photos have location data — it's usually off by default, or was stripped when they were shared through a messaging app. Originals from the camera roll work best.`;
  }
  return 'None of those files could be read as photos.';
}

/**
 * Name a coordinate from the bundled city index, via the geocoder route.
 *
 * Failure is fine and common — mid-ocean, or the endpoint being unreachable —
 * and the caller falls back to a date-based name rather than showing an error
 * for something cosmetic.
 */
async function resolveName(coordinate: LngLat): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/geocode?near=${coordinate[1].toFixed(4)},${coordinate[0].toFixed(4)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: { name: string }[] };
    return body.results?.[0]?.name ?? null;
  } catch {
    return null;
  }
}
