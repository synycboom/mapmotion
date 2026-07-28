'use client';

import { useRef, useState } from 'react';
import { importTrack, type ImportedTrack } from '@mapmotion/engine';

/**
 * GPX/KML file import. Parsing happens entirely in the browser — the file
 * never leaves the user's machine, which is both faster and one less privacy
 * question to answer.
 */
export function TrackImport({
  onImport,
}: {
  onImport: (track: ImportedTrack) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > 25 * 1024 * 1024) {
      setError('That file is over 25 MB — try trimming the track first.');
      return;
    }
    try {
      const text = await file.text();
      const result = importTrack(text, file.name);
      onImport({ ...result, name: result.name ?? stripExt(file.name) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div
        data-testid="track-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `1px dashed ${dragging ? '#e8590c' : '#34496b'}`,
          background: dragging ? 'rgba(232,89,12,0.08)' : 'transparent',
          borderRadius: 6,
          padding: '10px 12px',
          fontSize: 12,
          textAlign: 'center',
          color: '#9fb0c8',
          cursor: 'pointer',
        }}
      >
        Import a GPX or KML track
        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>
          drag a file here, or click to browse
        </div>
      </div>
      <input
        ref={inputRef}
        data-testid="track-file-input"
        type="file"
        accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml,text/xml"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
        style={{ display: 'none' }}
      />
      {error && (
        <p data-testid="import-error" style={{ color: '#ff8787', fontSize: 11, margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
