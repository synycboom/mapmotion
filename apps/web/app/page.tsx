'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { compileTrip, sceneAt, type Project } from '@mapmotion/engine';
import { buildStyle } from '../lib/mapStyle';
import { FrameApplier } from '../lib/applyFrame';
import { exportVideo, type ExportResult } from '../lib/exporter';

declare global {
  interface Window {
    __exportResult?: {
      ok: boolean;
      error?: string;
      codec?: string;
      ext?: string;
      frames?: number;
      wallMs?: number;
      msPerFrame?: number;
      realtimeFactor?: number;
      bytes?: number;
    };
    __exportB64?: string;
  }
}

function demoProject(small: boolean): Project {
  const stops = [
    { name: 'Bangkok', coordinate: [100.5018, 13.7563] as [number, number] },
    { name: 'Tokyo', coordinate: [139.6917, 35.6895] as [number, number] },
    { name: 'San Francisco', coordinate: [-122.4194, 37.7749] as [number, number] },
  ];
  return compileTrip('BKK → TYO → SF', stops, {
    format: small
      ? { width: 640, height: 360, fps: 30, durationMs: 4000 }
      : { width: 1280, height: 720, fps: 30 },
    stopZoom: small ? 3.2 : 4.4,
    dwellMs: small ? 400 : 1200,
    legMs: small ? 1200 : 2600,
  });
}

export default function Editor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const applierRef = useRef<FrameApplier | null>(null);
  const projectRef = useRef<Project | null>(null);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const rafRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const autotest = params.has('autotest');
    const project = demoProject(autotest && !params.has('hd'));
    projectRef.current = project;

    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: buildStyle(),
      center: project.camera[0]!.camera.center,
      zoom: project.camera[0]!.camera.zoom,
      interactive: false,
      attributionControl: false,
      pixelRatio: 1, // canvas backing == format resolution, exactly
      fadeDuration: 0, // no tile/label fade — deterministic frames
    });
    mapRef.current = map;

    const fit = () => {
      const vw = window.innerWidth - 48;
      const vh = window.innerHeight - 210;
      setScale(Math.min(vw / project.format.width, vh / project.format.height, 1));
    };
    fit();
    window.addEventListener('resize', fit);

    map.on('load', async () => {
      const applier = new FrameApplier(map, project);
      applier.install();
      applier.apply(sceneAt(project, 0));
      applierRef.current = applier;
      setReady(true);

      if (autotest) {
        try {
          const res = await exportVideo(map, applier, project, {
            watermark: 'MAPMOTION',
          });
          const buf = new Uint8Array(await res.blob.arrayBuffer());
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
          }
          window.__exportB64 = btoa(bin);
          window.__exportResult = {
            ok: true,
            codec: res.codec,
            ext: res.ext,
            frames: res.frames,
            wallMs: Math.round(res.wallMs),
            msPerFrame: Math.round(res.msPerFrame * 10) / 10,
            realtimeFactor: Math.round(res.realtimeFactor * 100) / 100,
            bytes: res.blob.size,
          };
        } catch (e) {
          window.__exportResult = { ok: false, error: String(e) };
        }
      }
    });

    return () => {
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(rafRef.current);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seek = (tMs: number) => {
    const project = projectRef.current;
    const applier = applierRef.current;
    if (!project || !applier) return;
    const clamped = Math.min(Math.max(tMs, 0), project.format.durationMs);
    playheadRef.current = clamped;
    setPlayheadMs(clamped);
    applier.apply(sceneAt(project, clamped));
  };

  const togglePlay = () => {
    const project = projectRef.current;
    if (!project) return;
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    if (playheadRef.current >= project.format.durationMs - 10) seek(0);
    let last = performance.now();
    const tick = (now: number) => {
      if (!playingRef.current) return;
      const dt = now - last;
      last = now;
      const next = playheadRef.current + dt;
      if (next >= project.format.durationMs) {
        seek(project.format.durationMs);
        playingRef.current = false;
        setPlaying(false);
        return;
      }
      seek(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const runExport = async () => {
    const map = mapRef.current;
    const applier = applierRef.current;
    const project = projectRef.current;
    if (!map || !applier || !project || exporting) return;
    playingRef.current = false;
    setPlaying(false);
    setExporting(true);
    setError(null);
    setResult(null);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    try {
      const res = await exportVideo(map, applier, project, {
        watermark: 'MAPMOTION',
        onProgress: (done, total) => setProgress(done / total),
      });
      setResult(res);
      setDownloadUrl(URL.createObjectURL(res.blob));
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
      seek(playheadRef.current);
    }
  };

  const project = projectRef.current;
  const dur = project?.format.durationMs ?? 1;

  return (
    <main style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Mapmotion</h1>
        <span style={{ opacity: 0.55, fontSize: 13 }}>
          Phase 0 spike — deterministic engine → MapLibre → WebCodecs
        </span>
      </div>

      <div
        style={{
          width: (project?.format.width ?? 1280) * scale,
          height: (project?.format.height ?? 720) * scale,
          overflow: 'hidden',
          borderRadius: 8,
          border: '1px solid #223',
        }}
      >
        <div
          ref={containerRef}
          style={{
            width: project?.format.width ?? 1280,
            height: project?.format.height ?? 720,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14, maxWidth: 900 }}>
        <button onClick={togglePlay} disabled={!ready || exporting} style={btn}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={dur}
          value={playheadMs}
          onChange={(e) => {
            playingRef.current = false;
            setPlaying(false);
            seek(Number(e.target.value));
          }}
          style={{ flex: 1 }}
        />
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, opacity: 0.7 }}>
          {(playheadMs / 1000).toFixed(1)}s / {(dur / 1000).toFixed(1)}s
        </span>
        <button onClick={runExport} disabled={!ready || exporting} style={{ ...btn, background: '#e8590c' }}>
          {exporting ? `Exporting ${(progress * 100).toFixed(0)}%` : 'Export video'}
        </button>
      </div>

      {error && (
        <p style={{ color: '#ff8787', fontSize: 13 }}>Export failed: {error}</p>
      )}
      {result && downloadUrl && (
        <p style={{ fontSize: 13, opacity: 0.85 }}>
          Done: {result.frames} frames · {result.codec} · {(result.blob.size / 1e6).toFixed(1)} MB ·{' '}
          {(result.wallMs / 1000).toFixed(1)}s wall ({result.realtimeFactor.toFixed(2)}× realtime) ·{' '}
          <a href={downloadUrl} download={`mapmotion.${result.ext}`} style={{ color: '#74c0fc' }}>
            download .{result.ext}
          </a>
        </p>
      )}
    </main>
  );
}

const btn: React.CSSProperties = {
  background: '#1c2a42',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 14,
  cursor: 'pointer',
};
