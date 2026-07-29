'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  autoStopZooms,
  compileTrip,
  sceneAt,
  DEFAULT_PIN,
  PIN_STYLES,
  type ImportedTrack,
  type PinAppearance,
  type LegMode,
  type LngLat,
  type PlaceHit,
  type Project,
  type TripStop,
} from '@mapmotion/engine';
import { FrameApplier } from '../lib/applyFrame';
import { exportVideo, type ExportFormat, type ExportResult } from '../lib/exporter';
import { STYLES, getStyle, customStyle, type StyleDef } from '../lib/styles';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_CAMERA,
  FORMATS,
  decodeState,
  encodeState,
  scaledDims,
  type CameraSettings,
  type FormatId,
  type MapAppearance,
} from '../lib/urlState';
import { CameraPanel } from '../components/CameraPanel';
import { PlaceSearch } from '../components/PlaceSearch';
import { StopList } from '../components/StopList';
import { useLegRoutes } from '../lib/useLegRoutes';
import { TrackImport } from '../components/TrackImport';
import { TEMPLATES, getTemplate } from '../lib/templates';
import { drawTitles } from '../lib/drawTitles';
import { ProjectLibrary } from '../components/ProjectLibrary';
import { AppearancePanel } from '../components/AppearancePanel';
import {
  applyLabelVisibility,
  applyProjection,
  applyTerrain,
  countLabelLayers,
  type LabelCategory,
} from '../lib/mapAppearance';
import { saveProject, type SavedProject } from '../lib/projectLibrary';
import { Timeline } from '../components/Timeline';
import { useNarrow, usePreviewFit } from '../lib/responsive';

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
  const [legModes, setLegModes] = useState<LegMode[]>(['air', 'air']);
  // Geometry from imported GPX/KML, parallel to legs. Too large for the URL,
  // so an imported leg that is reloaded from a link falls back to an arc
  // until the file is re-imported (or the project is loaded from the
  // library, which does persist geometry).
  const [trackGeometries, setTrackGeometries] = useState<(LngLat[] | null)[]>([]);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [outro, setOutro] = useState(false);
  const [mode, setMode] = useState<'quick' | 'studio'>('quick');
  const [legDurations, setLegDurations] = useState<(number | null)[]>([]);
  const [stopDwells, setStopDwells] = useState<(number | null)[]>([]);
  const [selected, setSelected] = useState<{ kind: 'leg' | 'stop'; index: number } | null>(null);
  const [pin, setPin] = useState<PinAppearance>(DEFAULT_PIN);
  const [appearance, setAppearance] = useState<MapAppearance>(DEFAULT_APPEARANCE);
  const [camera, setCamera] = useState<CameraSettings>(DEFAULT_CAMERA);
  const [layerCounts, setLayerCounts] = useState<Record<LabelCategory, number>>({
    places: 0, countries: 0, roads: 0, water: 0, pois: 0,
  });
  const [libraryKey, setLibraryKey] = useState(0);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('video');
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
  const [contextLost, setContextLost] = useState(false);
  /** Lets the map's style.load handler reach the latest appearance. */
  const applyAppearanceRef = useRef<(() => void) | null>(null);

  // ---- responsive layout ----
  const narrow = useNarrow();
  const previewRef = useRef<HTMLElement>(null);
  const fitDims = scaledDims(format, res);
  // Stacked, the preview gets half the screen and the controls scroll under
  // it. Side by side, it gets the window minus the transport row.
  const scale = usePreviewFit(
    previewRef,
    fitDims.width,
    fitDims.height,
    narrow ? 0.52 : 1,
    narrow ? 24 : 210,
  );

  // Road geometry for any leg set to 'drive'. Missing/failed lookups come
  // back as null and compileTrip arcs instead.
  const { geometries: routedGeometries, statuses: routeStatuses, metrics: legMetrics } = useLegRoutes(
    stops,
    legModes,
  );

  // One geometry list for the compiler: imported tracks win on 'track' legs,
  // routed roads on 'drive' legs, nothing (arc) otherwise.
  const legGeometries = useMemo(
    () =>
      Array.from({ length: Math.max(0, stops.length - 1) }, (_, i) =>
        legModes[i] === 'file'
          ? trackGeometries[i] ?? null
          : routedGeometries[i] ?? null,
      ),
    [stops.length, legModes, trackGeometries, routedGeometries],
  );

  const legStatuses = useMemo(
    () =>
      Array.from({ length: Math.max(0, stops.length - 1) }, (_, i) => {
        if (legModes[i] !== 'file') return routeStatuses[i] ?? 'idle';
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
      zoomPreset: camera.zoomPreset,
      stopZooms: camera.stopZooms,
      arc: camera.arc,
      bearing: camera.bearing,
      bearingMode: camera.bearingMode,
      orbitDeg: camera.orbit,
      travelEasing: camera.easing,
      pitch: appearance.pitch,
      pin,
      dwellMs: Math.round(1200 / speed),
      legMs: Math.round(2600 / speed),
      legModes,
      legGeometries,
      legDurations,
      stopDwells,
      title,
      subtitle,
      outro,
    });
  }, [
    stops,
    format,
    speed,
    res,
    legModes,
    legGeometries,
    legDurations,
    stopDwells,
    title,
    subtitle,
    outro,
    appearance.pitch,
    camera,
    pin,
  ]);

  /**
   * What automatic framing would choose for each stop — shown as the
   * placeholder in the stop list. Derived from the same function the compiler
   * uses, so the number in the UI is the number that renders.
   */
  const autoZooms = useMemo(() => {
    const out = scaledDims(format, res);
    return autoStopZooms(stops, Math.min(out.width, out.height));
  }, [stops, format, res]);

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
      appearance: DEFAULT_APPEARANCE,
      camera: DEFAULT_CAMERA,
      styleId: autotest ? 'minimal' : 'liberty',
      speed: 1,
      res: 1,
    });
    setStops(initial.stops);
    setLegModes(initial.legModes);
    setAppearance(initial.appearance);
    setCamera(initial.camera);
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
      zoomPreset: initial.camera.zoomPreset,
      stopZooms: initial.camera.stopZooms,
      arc: initial.camera.arc,
      bearing: initial.camera.bearing,
      bearingMode: initial.camera.bearingMode,
      orbitDeg: initial.camera.orbit,
      pitch: initial.appearance.pitch,
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

      // iOS Safari discards WebGL contexts under memory pressure and when a
      // tab is backgrounded for a while. Without preventDefault the browser
      // will not restore it, and the user is left with a permanently blank
      // map and no explanation.
      const canvas = map.getCanvas();
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        setContextLost(true);
      });
      canvas.addEventListener('webglcontextrestored', () => {
        setContextLost(false);
        // Layers live in the lost context; reinstall them and repaint.
        applierRef.current = null;
        rebuildLayers();
        applyAppearanceRef.current?.();
        seek(playheadRef.current);
      });

      map.on('error', (e) => {
        const msg = (e as { error?: Error }).error?.message ?? String(e);
        console.error('[mm-map-error]', msg);
        setMapErrors((prev) => (prev.includes(msg) ? prev : [...prev, msg].slice(-5)));
      });

      map.on('style.load', () => {
        rebuildLayers();
        applyAppearanceRef.current?.();
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
      // Rasterise vehicle sprites in the background; the next frame picks
      // them up. Export awaits this explicitly before capturing.
      void applier.ensureIcons().then(() => {
        if (applierRef.current === applier) {
          applier.apply(sceneAt(proj, playheadRef.current));
        }
      });
    } catch (e) {
      setError(`Layer install failed: ${e}`);
    }
  }, []);

  // ---- react to project changes (stops / format / speed / geometry) ----
  useEffect(() => {
    if (!booted || !project) return;
    const map = mapRef.current;
    if (!map) return;

    playingRef.current = false;
    setPlaying(false);
    playheadRef.current = 0;
    setPlayheadMs(0);

    let cancelled = false;
    const applyChange = () => {
      if (cancelled || mapRef.current !== map) return;
      map.resize();
      rebuildLayers();
    };

    if (map.isStyleLoaded()) {
      applyChange();
    } else {
      // The style can still be loading when a project change lands — most
      // often because road geometry arrived while tiles were in flight.
      // Waiting for idle rather than bailing out is essential: an early
      // return here silently drops the new geometry and the map keeps
      // showing the old arc forever, with no error and no retry.
      map.once('idle', applyChange);
    }

    return () => {
      cancelled = true;
      map.off('idle', applyChange);
    };
  }, [project, booted, rebuildLayers]);

  /**
   * Appearance is applied imperatively rather than through the project,
   * because it describes the BASEMAP (someone else's layers) rather than our
   * scene. Re-applied on every style load too — setStyle resets label
   * visibility and drops the terrain source.
   */
  const applyAppearance = useCallback((next: MapAppearance) => {
    const map = mapRef.current;
    if (!map) return;
    try {
      applyLabelVisibility(map, next.labels);
      applyProjection(map, next.projection);
      applyTerrain(map, next.terrain);
      setLayerCounts(countLabelLayers(map));
    } catch {
      /* appearance is decorative — never break the editor */
    }
  }, []);

  useEffect(() => {
    if (!booted) return;
    const map = mapRef.current;
    if (!map) return;
    // Applied immediately and unconditionally. Deferring to 'idle' looks
    // safer but isn't: a map with unreachable tiles (a blocked DEM host, a
    // slow network) may never go idle, and every queued appearance change
    // would then be lost forever with no error. These calls are individually
    // guarded and no-op harmlessly if the style isn't ready yet — and
    // 'style.load' re-applies them anyway.
    applyAppearance(appearance);
  }, [appearance, booted, styleId, applyAppearance]);

  useEffect(() => {
    applyAppearanceRef.current = () => applyAppearance(appearance);
  }, [appearance, applyAppearance]);

  // ---- keep the URL in sync so the map is shareable ----
  useEffect(() => {
    if (!booted) return;
    const qs = new URLSearchParams(
      encodeState({ stops, legModes, appearance, camera, format, styleId, speed, res }),
    );
    // Carry through params the editor doesn't own, so a dev/test link keeps
    // working after the first state sync.
    const incoming = new URLSearchParams(window.location.search);
    for (const key of ['styleUrl', 'autotest', 'hd']) {
      const v = incoming.get(key);
      if (v !== null) qs.set(key, v);
    }
    window.history.replaceState(null, '', `?${qs}`);
    setCopied(false);
  }, [stops, legModes, appearance, camera, format, styleId, speed, res, booted]);


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
        format: exportFormat,
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
  /**
   * Per-stop camera overrides are positional, so every mutation of `stops`
   * has to move them in step or a zoom set on Tokyo silently becomes a zoom
   * on whatever ends up in that slot.
   */
  const editStopZooms = (fn: (prev: (number | null)[]) => (number | null)[]) =>
    setCamera((prev) => ({ ...prev, stopZooms: fn(prev.stopZooms) }));

  const setStopZoom = (i: number, zoom: number | null) =>
    editStopZooms((prev) => {
      const next = [...prev];
      while (next.length < stops.length) next.push(null);
      next[i] = zoom;
      return next;
    });

  const addStop = (hit: PlaceHit) => {
    setStops((prev) => [...prev, { name: hit.name, coordinate: hit.coordinate }]);
    setLegModes((prev) => [...prev, 'air']);
    setTrackGeometries((prev) => [...prev, null]);
    setLegDurations((prev) => [...prev, null]);
    editStopZooms((prev) => [...prev, null]);
  };

  const removeStop = (i: number) => {
    setStops((prev) => prev.filter((_, j) => j !== i));
    editStopZooms((prev) => prev.filter((_, j) => j !== i));
    // Dropping a stop removes the leg that led into it (or out of it, for
    // the first stop).
    const leg = Math.max(0, i - 1);
    setLegModes((prev) => prev.filter((_, j) => j !== leg));
    setTrackGeometries((prev) => prev.filter((_, j) => j !== leg));
    setLegDurations((prev) => prev.filter((_, j) => j !== leg));
    setStopDwells((prev) => prev.filter((_, j) => j !== i));
    setSelected(null);
  };

  const moveStop = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    setStops((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    editStopZooms((prev) => {
      const next = [...prev];
      while (next.length < stops.length) next.push(null);
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
        if (leg >= 0 && leg < next.length) next[leg] = 'air';
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
    setSelected(null);
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
      setLegModes(['file']);
      setTrackGeometries([t.track]);
      setLegDurations([null]);
      setStopDwells([]);
    } else if (t.waypoints.length >= 2) {
      setStops(t.waypoints.map((w) => ({ ...w })));
      setLegModes(t.waypoints.slice(1).map(() => 'air' as LegMode));
      setTrackGeometries(t.waypoints.slice(1).map(() => null));
      setLegDurations(t.waypoints.slice(1).map(() => null));
      setStopDwells([]);
    }
    // A fresh trip means the old positional overrides describe nothing.
    editStopZooms(() => []);
    playheadRef.current = 0;
    setPlayheadMs(0);
  };

  const handleSave = (name: string) => {
    const rec = saveProject({
      name,
      stops,
      legModes,
      trackGeometries,
      legDurations,
      stopDwells,
      appearance,
      camera,
      pin,
      format,
      styleId,
      speed,
      title,
      subtitle,
      outro,
    });
    setSavedAs(rec ? name : null);
    setError(rec ? null : 'Could not save — browser storage is unavailable or full.');
    setLibraryKey((n) => n + 1);
  };

  const handleLoad = (p: SavedProject) => {
    setStops(p.stops.map((x) => ({ ...x, coordinate: [...x.coordinate] as LngLat })));
    setLegModes([...p.legModes]);
    setTrackGeometries(p.trackGeometries?.map((g) => (g ? [...g] : null)) ?? []);
    setLegDurations(p.legDurations ? [...p.legDurations] : []);
    setStopDwells(p.stopDwells ? [...p.stopDwells] : []);
    if (p.appearance) setAppearance(p.appearance);
    // Older saves predate camera settings; fall back rather than crash.
    setCamera(p.camera ? { ...DEFAULT_CAMERA, ...p.camera } : DEFAULT_CAMERA);
    if (p.pin) setPin(p.pin);
    setSelected(null);
    setFormat(p.format);
    setSpeed(p.speed);
    setTitle(p.title ?? '');
    setSubtitle(p.subtitle ?? '');
    setOutro(!!p.outro);
    setSavedAs(p.name);
    playheadRef.current = 0;
    setPlayheadMs(0);
    if (p.styleId && p.styleId !== styleId) void switchStyle(p.styleId);
  };

  const applyTemplate = (id: string) => {
    const tpl = getTemplate(id);
    if (!tpl) return;
    setStops(tpl.stops.map((x) => ({ ...x, coordinate: [...x.coordinate] as LngLat })));
    setLegModes([...tpl.legModes]);
    setTrackGeometries(tpl.legModes.map(() => null));
    setLegDurations(tpl.legModes.map(() => null));
    setStopDwells([]);
    editStopZooms(() => []);
    setSelected(null);
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
      while (next.length < stops.length - 1) next.push('air');
      next[leg] = mode;
      return next;
    });

  const dims = scaledDims(format, res);
  const dur = project?.format.durationMs ?? 1;

  return (
    <main
      style={{
        padding: narrow ? 12 : 20,
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        gap: narrow ? 14 : 20,
        alignItems: 'flex-start',
      }}
    >
      {/* ---------------- Quick mode panel ---------------- */}
      {/* Stacked, the preview goes first — it's the thing you came to see. */}
      <aside
        data-testid="controls"
        style={{
          width: narrow ? '100%' : 340,
          flexShrink: 0,
          order: narrow ? 2 : 0,
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>Mapmotion</h1>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {(['quick', 'studio'] as const).map((m) => (
              <button
                key={m}
                data-testid={`mode-${m}`}
                onClick={() => setMode(m)}
                style={{
                  ...btn,
                  padding: '4px 10px',
                  fontSize: 11,
                  textTransform: 'capitalize',
                  background: mode === m ? '#e8590c' : '#1c2a42',
                  borderColor: mode === m ? '#e8590c' : '#34496b',
                }}
              >
                {m}
              </button>
            ))}
          </div>
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
          legMetrics={legMetrics}
          stopZooms={camera.stopZooms}
          autoZooms={autoZooms}
          onRemove={removeStop}
          onMove={moveStop}
          onSetLegMode={setLegMode}
          onSetStopZoom={setStopZoom}
        />

        <div style={{ marginTop: 18 }}>
          <Label>Marker style</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {PIN_STYLES.map((ps) => (
              <button
                key={ps.id}
                data-testid={`pin-${ps.id}`}
                onClick={() => setPin({ ...pin, style: ps.id })}
                title={ps.hint}
                disabled={exporting}
                style={{
                  ...btn,
                  padding: '4px 9px',
                  fontSize: 11,
                  borderRadius: 999,
                  background: pin.style === ps.id ? '#e8590c' : '#1c2a42',
                  borderColor: pin.style === ps.id ? '#e8590c' : '#34496b',
                }}
              >
                {ps.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input
              data-testid="pin-color"
              type="color"
              value={pin.color}
              disabled={exporting}
              onChange={(e) => setPin({ ...pin, color: e.target.value })}
              style={{ width: 30, height: 26, padding: 0, border: '1px solid #34496b', borderRadius: 4, background: 'transparent' }}
            />
            {pin.style === 'emoji' && (
              <input
                data-testid="pin-emoji-input"
                value={pin.emoji ?? ''}
                onChange={(e) => setPin({ ...pin, emoji: e.target.value.slice(0, 4) })}
                placeholder="📍"
                disabled={exporting}
                style={{ ...inputStyle, width: 60, textAlign: 'center' }}
              />
            )}
            <input
              data-testid="pin-size"
              type="range"
              min={0.4}
              max={3}
              step={0.1}
              value={pin.size}
              disabled={exporting}
              onChange={(e) => setPin({ ...pin, size: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 10, opacity: 0.55, minWidth: 26 }}>
              {pin.size.toFixed(1)}×
            </span>
          </div>
        </div>

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
            data-testid="speed-slider"
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

        <CameraPanel
          camera={camera}
          onChange={setCamera}
          pitch={appearance.pitch}
          onPitchChange={(deg) => setAppearance((a) => ({ ...a, pitch: deg }))}
          disabled={exporting}
        />

        <AppearancePanel
          appearance={appearance}
          onChange={setAppearance}
          layerCounts={layerCounts}
          disabled={exporting}
        />

        <ProjectLibrary
          onLoad={handleLoad}
          onSave={handleSave}
          currentName={title || savedAs || ''}
          reloadKey={libraryKey}
        />

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
      <section
        ref={previewRef}
        data-testid="preview-pane"
        style={{
          flex: 1,
          minWidth: 0,
          width: narrow ? '100%' : undefined,
          order: narrow ? 1 : 0,
        }}
      >
        <div
          data-testid="preview-frame"
          style={{
            position: 'relative',
            width: dims.width * scale,
            height: dims.height * scale,
            maxWidth: '100%',
            // A vertical format on a phone leaves slack on both sides; hugging
            // the left edge looks like a bug rather than a choice.
            marginInline: narrow ? 'auto' : undefined,
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
              // The map is non-interactive, so touches belong to the page.
              touchAction: 'pan-y',
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
          {contextLost && (
            <div
              data-testid="context-lost"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(9,15,26,0.85)',
                fontSize: 13,
                textAlign: 'center',
                padding: 20,
              }}
            >
              The browser dropped the map&apos;s graphics context — usually low
              memory. It should come back on its own; reload if it doesn&apos;t.
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: narrow ? 8 : 12,
            alignItems: 'center',
            marginTop: 14,
            width: narrow ? '100%' : dims.width * scale,
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
            style={{ flex: 1, minWidth: 110 }}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, opacity: 0.7 }}>
            {(playheadMs / 1000).toFixed(1)}s / {(dur / 1000).toFixed(1)}s
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['video', 'gif'] as const).map((f) => (
              <button
                key={f}
                data-testid={`export-format-${f}`}
                onClick={() => setExportFormat(f)}
                disabled={exporting}
                title={f === 'gif' ? 'Animated GIF — smaller frame rate, no audio' : 'MP4 / WebM video'}
                style={{
                  ...btn,
                  padding: '8px 10px',
                  fontSize: 11,
                  background: exportFormat === f ? '#34496b' : '#1c2a42',
                  borderColor: exportFormat === f ? '#4a6592' : '#34496b',
                }}
              >
                {f === 'video' ? 'MP4' : 'GIF'}
              </button>
            ))}
          </div>
          <button
            onClick={runExport}
            data-testid="export-button"
            disabled={!ready || exporting || !project}
            style={{ ...btn, background: '#e8590c', borderColor: '#e8590c' }}
          >
            {exporting
              ? `Exporting ${(progress * 100).toFixed(0)}%`
              : `Export ${exportFormat === 'gif' ? 'GIF' : 'video'}`}
          </button>
        </div>

        {mode === 'studio' && project && (
          <Timeline
            project={project}
            stops={stops}
            playheadMs={playheadMs}
            legDurations={legDurations}
            stopDwells={stopDwells}
            selected={selected}
            onSelect={setSelected}
            onSeek={seek}
            onSetLegDuration={(i, ms) =>
              setLegDurations((prev) => {
                const next = [...prev];
                while (next.length < stops.length - 1) next.push(null);
                next[i] = ms;
                return next;
              })
            }
            onSetStopDwell={(i, ms) =>
              setStopDwells((prev) => {
                const next = [...prev];
                while (next.length < stops.length) next.push(null);
                next[i] = ms;
                return next;
              })
            }
            onReset={() => {
              setLegDurations([]);
              setStopDwells([]);
              setSelected(null);
            }}
          />
        )}

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
