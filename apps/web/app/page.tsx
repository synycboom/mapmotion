'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  compileTrip,
  sceneAt,
  type ImportedTrack,
  type LegMode,
  type LngLat,
  type PlaceHit,
  type Project,
  type TripStop,
} from '@mapmotion/engine';
import { FrameApplier } from '../lib/applyFrame';
import { exportVideo, type ExportResult } from '../lib/exporter';
import { STYLES, getStyle, customStyle, type StyleDef } from '../lib/styles';
import {
  FORMATS,
  decodeState,
  encodeState,
  scaledDims,
  type FormatId,
} from '../lib/urlState';
import { PlaceSearch } from '../components/PlaceSearch';
import { StopList } from '../components/StopList';
import { useLegRoutes } from '../lib/useLegRoutes';
import { TrackImport } from '../components/TrackImport';
import { TEMPLATES, getTemplate } from '../lib/templates';
import { drawTitles } from '../lib/drawTitles';

declare global {
  interface Window {
    __exportResult?: Record<string, unknown>;
    __exportB64?: string;
    __map?: maplibregl.Map;
    __mmDiag?: () => Record<string, unknown>;
  }
}

const DEFAULT_STOPS: TripStop[] = [
  { name: 'Bangkok', coordinate: [100.5018, 13.7563] },
  { name: 'Tokyo', coordinate: [139.6917, 35.6895] },
  { name: 'San Francisco', coordinate: [-122.4194, 37.7749] },
];

export default function Editor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const applierRef = useRef<FrameApplier | null>(null);
  const projectRef = useRef<Project | null>(null);
  const styleRef = useRef<StyleDef>(getStyle('liberty'));
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const rafRef = useRef(0);
  const autotestRanRef = useRef(false);

  const [booted, setBooted] = useState(false);
  const [stops, setStops] = useState<TripStop[]>(DEFAULT_STOPS);
  const [legModes, setLegModes] = useState<LegMode[]>(['flight', 'flight']);
  // Geometry from imported GPX/KML, parallel to legs. Too large for the URL,
  // so an imported leg that is reloaded from a link falls back to an arc
  // until the file is re-imported (or the project is loaded from the
  // library, which does persist geometry).
  const [trackGeometries, setTrackGeometries] = useState<(LngLat[] | null)[]>([]);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [outro, setOutro] = useState(false);
  const [format, setFormat] = useState<FormatId>('16x9');
  const [speed, setSpeed] = useState(1);
  const [res, setRes] = useState(1);
  const [styleId, setStyleId] = useState('liberty');
  const [extraStyle, setExtraStyle] = useState<StyleDef | null>(null);

  const [ready, setReady] = useState(false);
  const [styleLoading, setStyleLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapErrors, setMapErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [scale, setScale] = useState(0.5);

  // Road geometry for any leg set to 'drive'. Missing/failed lookups come
  // back as null and compileTrip arcs instead.
  const { geometries: routedGeometries, statuses: routeStatuses } = useLegRoutes(
    stops,
    legModes,
  );

  // One geometry list for the compiler: imported tracks win on 'track' legs,
  // routed roads on 'drive' legs, nothing (arc) otherwise.
  const legGeometries = useMemo(
    () =>
      Array.from({ length: Math.max(0, stops.length - 1) }, (_, i) =>
        legModes[i] === 'track'
          ? trackGeometries[i] ?? null
          : routedGeometries[i] ?? null,
      ),
    [stops.length, legModes, trackGeometries, routedGeometries],
  );

  const legStatuses = useMemo(
    () =>
      Array.from({ length: Math.max(0, stops.length - 1) }, (_, i) => {
        if (legModes[i] !== 'track') return routeStatuses[i] ?? 'idle';
        return trackGeometries[i]?.length ? 'ok' : 'fallback';
      }),
    [stops.length, legModes, trackGeometries, routeStatuses],
  );

  /** The compiled scene — recomputed whenever the inputs change. */
  const project = useMemo<Project | null>(() => {
    if (stops.length < 2) return null;
    const out = scaledDims(format, res);
    return compileTrip('Trip', stops, {
      format: { width: out.width, height: out.height, fps: 30 },
      stopZoom: 4.4,
      dwellMs: Math.round(1200 / speed),
      legMs: Math.round(2600 / speed),
      legModes,
      legGeometries,
      title,
      subtitle,
      outro,
    });
  }, [stops, format, speed, res, legModes, legGeometries, title, subtitle, outro]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // ---- boot: read URL state, then create the map with a resolved style ----
  useEffect(() => {
    let disposed = false;
    const params = new URLSearchParams(location.search);
    const autotest = params.has('autotest');

    const initial = decodeState(location.search, {
      stops: DEFAULT_STOPS,
      format: '16x9',
      legModes: [],
      styleId: autotest ? 'minimal' : 'liberty',
      speed: 1,
      res: 1,
    });
    setStops(initial.stops);
    setLegModes(initial.legModes);
    setFormat(initial.format);
    setSpeed(initial.speed);
    setRes(initial.res);

    const styleUrlParam = params.get('styleUrl');
    const initialStyle = styleUrlParam
      ? customStyle(styleUrlParam)
      : getStyle(initial.styleId);
    if (styleUrlParam) setExtraStyle(initialStyle);
    styleRef.current = initialStyle;
    setStyleId(initialStyle.id);
    setBooted(true);

    const bootProject = compileTrip('Trip', initial.stops, {
      format: { ...scaledDims(initial.format, initial.res), fps: 30 },
      stopZoom: 4.4,
      dwellMs: Math.round(1200 / initial.speed),
      legMs: Math.round(2600 / initial.speed),
    });
    projectRef.current = bootProject;

    void (async () => {
      let resolved: string | maplibregl.StyleSpecification;
      try {
        resolved = (await initialStyle.resolve()) as string | maplibregl.StyleSpecification;
      } catch (e) {
        setError(`Style "${initialStyle.label}" failed to load: ${e}`);
        setStyleLoading(false);
        return;
      }
      if (disposed || !containerRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: resolved as never,
        center: bootProject.camera[0]!.camera.center,
        zoom: bootProject.camera[0]!.camera.zoom,
        interactive: false,
        attributionControl: false,
        pixelRatio: 1,
        fadeDuration: 0,
      });
      mapRef.current = map;
      window.__map = map;

      map.on('error', (e) => {
        const msg = (e as { error?: Error }).error?.message ?? String(e);
        console.error('[mm-map-error]', msg);
        setMapErrors((prev) => (prev.includes(msg) ? prev : [...prev, msg].slice(-5)));
      });

      map.on('style.load', () => {
        rebuildLayers();
        setStyleLoading(false);
        setReady(true);
      });

      map.once('load', () => {
        if (autotest && !autotestRanRef.current) {
          autotestRanRef.current = true;
          void runAutotest(map);
        }
      });

      window.__mmDiag = () => {
        const style = map.getStyle();
        return {
          styleName: style?.name,
          layerCount: style?.layers.length,
          sources: Object.keys(style?.sources ?? {}),
          styleLoaded: map.isStyleLoaded(),
          areTilesLoaded: map.areTilesLoaded(),
          canvas: { w: map.getCanvas().width, h: map.getCanvas().height },
          camera: {
            center: map.getCenter().toArray(),
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          },
          stopCount: projectRef.current?.markers.length ?? 0,
        };
      };
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Tear down and re-add our layers for the current project + style.
   * Deliberately does NOT check map.isStyleLoaded(): inside a 'style.load'
   * handler that can still report false, which would skip the very first
   * install. Callers that fire outside style.load do the check themselves.
   */
  const rebuildLayers = useCallback(() => {
    const map = mapRef.current;
    const proj = projectRef.current;
    if (!map || !proj) return;
    const s = styleRef.current;
    const applier = new FrameApplier(map, proj);
    applierRef.current = applier;
    try {
      applier.install({
        font: s.markerFont,
        textColor: s.markerTextColor,
        haloColor: s.markerHaloColor,
      });
      const t = Math.min(playheadRef.current, proj.format.durationMs);
      const frame = sceneAt(proj, t);
      applier.apply(frame);
      paintOverlay(frame.titles, proj.format.width, proj.format.height);
    } catch (e) {
      setError(`Layer install failed: ${e}`);
    }
  }, []);

  // ---- react to project changes (stops / format / speed) ----
  useEffect(() => {
    if (!booted || !project) return;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    playingRef.current = false;
    setPlaying(false);
    playheadRef.current = 0;
    setPlayheadMs(0);
    map.resize();
    rebuildLayers();
  }, [project, booted, rebuildLayers]);

  // ---- keep the URL in sync so the map is shareable ----
  useEffect(() => {
    if (!booted) return;
    const qs = encodeState({ stops, legModes, format, styleId, speed, res });
    window.history.replaceState(null, '', `?${qs}`);
    setCopied(false);
  }, [stops, legModes, format, styleId, speed, res, booted]);

  // ---- fit the preview to the viewport ----
  useEffect(() => {
    const out = scaledDims(format, res);
    const fit = () => {
      const vw = window.innerWidth - 400;
      const vh = window.innerHeight - 210;
      setScale(Math.min(vw / out.width, vh / out.height, 1));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [format, res]);

  const runAutotest = async (map: maplibregl.Map) => {
    try {
      const proj = projectRef.current!;
      if (!applierRef.current) rebuildLayers();
      const applier = applierRef.current;
      if (!applier) throw new Error('layers were never installed');
      const s = styleRef.current;
      const res = await exportVideo(map, applier, proj, {
        watermark: 'MAPMOTION',
        attribution: s.attribution,
        settleCapMs: s.settleCapMs,
      });
      const buf = new Uint8Array(await res.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      window.__exportB64 = btoa(bin);
      window.__exportResult = {
        ok: true,
        codec: res.codec,
        ext: res.ext,
        frames: res.frames,
        wallMs: Math.round(res.wallMs),
        realtimeFactor: Math.round(res.realtimeFactor * 100) / 100,
        bytes: res.blob.size,
      };
    } catch (e) {
      window.__exportResult = { ok: false, error: String(e) };
    }
  };

  const switchStyle = async (id: string) => {
    const map = mapRef.current;
    if (!map || exporting) return;
    const def = extraStyle && id === extraStyle.id ? extraStyle : getStyle(id);
    styleRef.current = def;
    setStyleId(def.id);
    setStyleLoading(true);
    setError(null);
    setMapErrors([]);
    try {
      const resolved = await def.resolve();
      if (!map.isStyleLoaded()) {
        await new Promise<void>((r) => map.once('idle', () => r()));
      }
      map.setStyle(resolved as never);
    } catch (e) {
      setStyleLoading(false);
      setError(`Style "${def.label}" failed to load: ${e}`);
    }
  };

  const seek = (tMs: number) => {
    const proj = projectRef.current;
    const applier = applierRef.current;
    if (!proj || !applier) return;
    const clamped = Math.min(Math.max(tMs, 0), proj.format.durationMs);
    playheadRef.current = clamped;
    setPlayheadMs(clamped);
    const frame = sceneAt(proj, clamped);
    applier.apply(frame);
    paintOverlay(frame.titles, proj.format.width, proj.format.height);
  };

  /**
   * Titles in the preview go through the SAME drawTitles() the exporter uses,
   * on a transparent canvas over the map — so what you see is what you get.
   */
  const paintOverlay = (
    titles: ReturnType<typeof sceneAt>['titles'],
    w: number,
    h: number,
  ) => {
    const c = overlayRef.current;
    if (!c) return;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    drawTitles(ctx, titles, w, h);
  };

  const togglePlay = () => {
    const proj = projectRef.current;
    if (!proj) return;
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    if (playheadRef.current >= proj.format.durationMs - 10) seek(0);
    let last = performance.now();
    const tick = (now: number) => {
      if (!playingRef.current) return;
      const dt = now - last;
      last = now;
      const next = playheadRef.current + dt;
      if (next >= proj.format.durationMs) {
        seek(proj.format.durationMs);
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
    const proj = projectRef.current;
    if (!map || !applier || !proj || exporting) return;
    playingRef.current = false;
    setPlaying(false);
    setExporting(true);
    setError(null);
    setResult(null);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    try {
      const s = styleRef.current;
      const res = await exportVideo(map, applier, proj, {
        watermark: 'MAPMOTION',
        attribution: s.attribution,
        settleCapMs: s.settleCapMs,
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

  // Stops and legs must stay length-consistent: legs = stops - 1. Each
  // mutation below fixes up legModes in the same commit so the two never
  // disagree (a mismatch would silently mis-assign modes to legs).
  const addStop = (hit: PlaceHit) => {
    setStops((prev) => [...prev, { name: hit.name, coordinate: hit.coordinate }]);
    setLegModes((prev) => [...prev, 'flight']);
    setTrackGeometries((prev) => [...prev, null]);
  };

  const removeStop = (i: number) => {
    setStops((prev) => prev.filter((_, j) => j !== i));
    // Dropping a stop removes the leg that led into it (or out of it, for
    // the first stop).
    const leg = Math.max(0, i - 1);
    setLegModes((prev) => prev.filter((_, j) => j !== leg));
    setTrackGeometries((prev) => prev.filter((_, j) => j !== leg));
  };

  const moveStop = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    setStops((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    // Reordering changes which places each leg connects, so modes no longer
    // describe the same journey. Reset the two touched legs to flight rather
    // than silently keeping a 'drive' that now spans an ocean.
    const touched = [Math.min(i, j) - 1, Math.min(i, j)];
    setLegModes((prev) => {
      const next = [...prev];
      for (const leg of touched) {
        if (leg >= 0 && leg < next.length) next[leg] = 'flight';
      }
      return next;
    });
    setTrackGeometries((prev) => {
      const next = [...prev];
      for (const leg of touched) {
        if (leg >= 0 && leg < next.length) next[leg] = null;
      }
      return next;
    });
  };

  /**
   * Importing replaces the trip: the file's own path becomes a single leg
   * between its endpoints. Files that carry only waypoints (no track) become
   * ordinary stops instead.
   */
  const importGpx = (t: ImportedTrack) => {
    if (t.track.length >= 2) {
      const start = t.track[0]!;
      const end = t.track[t.track.length - 1]!;
      setStops([
        { name: t.waypoints[0]?.name ?? 'Start', coordinate: start },
        { name: t.waypoints[t.waypoints.length - 1]?.name ?? t.name ?? 'Finish', coordinate: end },
      ]);
      setLegModes(['track']);
      setTrackGeometries([t.track]);
    } else if (t.waypoints.length >= 2) {
      setStops(t.waypoints.map((w) => ({ ...w })));
      setLegModes(t.waypoints.slice(1).map(() => 'flight' as LegMode));
      setTrackGeometries(t.waypoints.slice(1).map(() => null));
    }
    playheadRef.current = 0;
    setPlayheadMs(0);
  };

  const applyTemplate = (id: string) => {
    const tpl = getTemplate(id);
    if (!tpl) return;
    setStops(tpl.stops.map((x) => ({ ...x, coordinate: [...x.coordinate] as LngLat })));
    setLegModes([...tpl.legModes]);
    setTrackGeometries(tpl.legModes.map(() => null));
    setFormat(tpl.format);
    setSpeed(tpl.speed);
    setTitle(tpl.label);
    setSubtitle('');
    playheadRef.current = 0;
    setPlayheadMs(0);
    if (tpl.styleId !== styleId) void switchStyle(tpl.styleId);
  };

  const setLegMode = (leg: number, mode: LegMode) =>
    setLegModes((prev) => {
      const next = [...prev];
      while (next.length < stops.length - 1) next.push('flight');
      next[leg] = mode;
      return next;
    });

  const dims = scaledDims(format, res);
  const dur = project?.format.durationMs ?? 1;

  return (
    <main style={{ padding: 20, display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* ---------------- Quick mode panel ---------------- */}
      <aside style={{ width: 340, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>Mapmotion</h1>
          <span style={{ opacity: 0.5, fontSize: 12 }}>Quick mode</span>
        </div>

        <div style={{ marginBottom: 12 }}>
          <Label>Start from a template</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                data-testid={`template-${tpl.id}`}
                onClick={() => applyTemplate(tpl.id)}
                title={tpl.blurb}
                disabled={exporting}
                style={{
                  ...btn,
                  padding: '5px 10px',
                  fontSize: 11,
                  borderRadius: 999,
                }}
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        <PlaceSearch onPick={addStop} />
        <TrackImport onImport={importGpx} />
        <StopList
          stops={stops}
          legModes={legModes}
          legStatuses={legStatuses}
          onRemove={removeStop}
          onMove={moveStop}
          onSetLegMode={setLegMode}
        />

        <div style={{ marginTop: 18 }}>
          <Label>Title card</Label>
          <input
            data-testid="title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Video title (optional)"
            disabled={exporting}
            style={inputStyle}
          />
          <input
            data-testid="subtitle-input"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="Subtitle"
            disabled={exporting || !title}
            style={{ ...inputStyle, marginTop: 5 }}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              opacity: title ? 0.8 : 0.4,
              marginTop: 6,
            }}
          >
            <input
              data-testid="outro-toggle"
              type="checkbox"
              checked={outro}
              disabled={exporting || !title}
              onChange={(e) => setOutro(e.target.checked)}
            />
            Repeat as an end card
          </label>
        </div>

        <div style={{ marginTop: 18 }}>
          <Label>Format</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(Object.keys(FORMATS) as FormatId[]).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                disabled={exporting}
                style={{
                  ...btn,
                  flex: 1,
                  padding: '7px 4px',
                  fontSize: 12,
                  background: f === format ? '#e8590c' : '#1c2a42',
                  borderColor: f === format ? '#e8590c' : '#34496b',
                }}
              >
                {f.replace('x', ':')}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, opacity: 0.45, margin: '5px 0 0' }}>
            {FORMATS[format].label} · {dims.width}×{dims.height}
            {res !== 1 && ` · draft ${Math.round(res * 100)}%`}
          </p>
        </div>

        <div style={{ marginTop: 16 }}>
          <Label>Speed · {speed.toFixed(1)}×</Label>
          <input
            type="range"
            min={0.5}
            max={2.5}
            step={0.1}
            value={speed}
            disabled={exporting}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <Label>Map style</Label>
          <select
            value={styleId}
            onChange={(e) => void switchStyle(e.target.value)}
            disabled={exporting}
            style={{ ...btn, width: '100%', padding: '8px 10px' }}
          >
            {(extraStyle ? [extraStyle, ...STYLES] : STYLES).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={() => {
            void navigator.clipboard?.writeText(location.href);
            setCopied(true);
          }}
          style={{ ...btn, width: '100%', marginTop: 16, fontSize: 13 }}
        >
          {copied ? 'Link copied ✓' : 'Copy shareable link'}
        </button>
      </aside>

      {/* ---------------- Preview + transport ---------------- */}
      <section style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            position: 'relative',
            width: dims.width * scale,
            height: dims.height * scale,
            overflow: 'hidden',
            borderRadius: 8,
            border: '1px solid #223',
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: dims.width,
              height: dims.height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
          <canvas
            ref={overlayRef}
            data-testid="title-overlay"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: dims.width * scale,
              height: dims.height * scale,
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 6,
              bottom: 4,
              fontSize: 10,
              color: '#fff',
              textShadow: '0 0 3px rgba(0,0,0,0.9)',
              pointerEvents: 'none',
            }}
          >
            {styleRef.current.attribution}
          </div>
          {(styleLoading || !project) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(9,15,26,0.6)',
                fontSize: 14,
                textAlign: 'center',
                padding: 20,
              }}
            >
              {!project ? 'Add at least two stops to build an animation.' : 'Loading style…'}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            marginTop: 14,
            width: dims.width * scale,
            maxWidth: '100%',
          }}
        >
          <button onClick={togglePlay} disabled={!ready || exporting || !project} style={btn}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <input
            type="range"
            min={0}
            max={dur}
            value={playheadMs}
            disabled={!project}
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
          <button
            onClick={runExport}
            disabled={!ready || exporting || !project}
            style={{ ...btn, background: '#e8590c', borderColor: '#e8590c' }}
          >
            {exporting ? `Exporting ${(progress * 100).toFixed(0)}%` : 'Export video'}
          </button>
        </div>

        {error && <p style={{ color: '#ff8787', fontSize: 13 }}>{error}</p>}
        {mapErrors.length > 0 && (
          <div style={{ color: '#ffa8a8', fontSize: 12, marginTop: 4 }}>
            Map errors:
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {mapErrors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {result && downloadUrl && (
          <p style={{ fontSize: 13, opacity: 0.85 }}>
            {result.frames} frames · {result.codec} · {(result.blob.size / 1e6).toFixed(1)} MB ·{' '}
            {(result.wallMs / 1000).toFixed(1)}s ({result.realtimeFactor.toFixed(2)}× realtime) ·{' '}
            <a href={downloadUrl} download={`mapmotion.${result.ext}`} style={{ color: '#74c0fc' }}>
              download .{result.ext}
            </a>
          </p>
        )}
      </section>
    </main>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 6, letterSpacing: 0.3 }}>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111c2e',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 13,
  boxSizing: 'border-box',
};

const btn: React.CSSProperties = {
  background: '#1c2a42',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 14,
  cursor: 'pointer',
};
