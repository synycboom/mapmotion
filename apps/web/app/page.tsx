'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  DEFAULT_ANNOTATION,
  annotationSpec,
  autoStopZooms,
  beatPeriodMs,
  compileTrip,
  quantiseDurations,
  sceneAt,
  tripSegments,
  DEFAULT_PIN,
  PIN_STYLES,
  type Annotation,
  type AnnotationKind,
  type AudioTrack,
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
import { AudioPanel } from '../components/AudioPanel';
import { AudioPreview, type AudioSource } from '../lib/audioSource';
import { PlaceSearch } from '../components/PlaceSearch';
import { StopList } from '../components/StopList';
import { useLegRoutes } from '../lib/useLegRoutes';
import { TrackImport } from '../components/TrackImport';
import { PhotoImport } from '../components/PhotoImport';
import type { ImportedPhotos } from '../lib/photoImport';
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
import { EditorShell } from '../components/EditorShell';
import { Storyboard } from '../components/Storyboard';
import { RegionPanel, type RegionSetting } from '../components/RegionPanel';
import {
  AnnotatePanel,
  newAnnotation,
  type AnnotationSetting,
} from '../components/AnnotatePanel';
import { initAnalytics, track, trackOnce } from '../lib/analytics';

declare global {
  interface Window {
    __exportResult?: Record<string, unknown>;
    __exportB64?: string;
    __map?: maplibregl.Map;
    __mmProject?: Project;
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
  // Per-stop marker overrides, parallel to stops. Photo import fills these
  // with the user's own photographs, which is the whole point of it.
  const [pinOverrides, setPinOverrides] = useState<(Partial<PinAppearance> | null)[]>([]);
  const [appearance, setAppearance] = useState<MapAppearance>(DEFAULT_APPEARANCE);
  const [camera, setCamera] = useState<CameraSettings>(DEFAULT_CAMERA);
  // Decoded samples are megabytes and not serialisable, so they live beside
  // the project rather than inside it; only the AudioTrack metadata is
  // compiled in, saved and exported.
  const [audio, setAudio] = useState<AudioSource | null>(null);
  const audioPreviewRef = useRef<AudioPreview | null>(null);
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
  /** Which panel the rail has open; null means the map has the whole screen. */
  const [activePanel, setActivePanel] = useState<string | null>('trip');
  /** Country/group highlights. Boundary geometry is fetched on demand. */
  const [regions, setRegions] = useState<RegionSetting[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationSetting[]>([]);
  /** Index of the annotation currently collecting map clicks, or null. */
  const [placing, setPlacing] = useState<number | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<number | null>(null);
  /** Lets the map's style.load handler reach the latest appearance. */
  const applyAppearanceRef = useRef<(() => void) | null>(null);

  // ---- responsive layout ----
  const narrow = useNarrow();
  const previewRef = useRef<HTMLDivElement>(null);
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
    const compiled = compileTrip('Trip', stops, {
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
      pinOverrides,
      dwellMs: Math.round(1200 / speed),
      legMs: Math.round(2600 / speed),
      legModes,
      legGeometries,
      legDurations,
      stopDwells,
      title,
      subtitle,
      outro,
      regions,
    });
    // Annotations are attached after compiling rather than passed in: they
    // are positioned in absolute coordinates and timed as a fraction of the
    // finished video, so they need the duration the compiler just produced.
    const total = compiled.format.durationMs;
    compiled.annotations = annotations
      .filter((a) => a.coordinates.length >= (annotationSpec(a.kind)?.points ?? 1))
      .map((a, i) => ({
        id: `ann-${i}`,
        kind: a.kind,
        coordinates: a.coordinates.map((c) => [...c] as LngLat),
        color: a.color,
        opacity: 1,
        enterMs: Math.round(a.enterAt * total),
        enterDurationMs: DEFAULT_ANNOTATION.enterDurationMs,
        exitMs: a.exitAt === null ? null : Math.round(a.exitAt * total),
        exitDurationMs: DEFAULT_ANNOTATION.exitDurationMs,
        text: a.text,
        fontSize: a.fontSize,
        haloColor: DEFAULT_ANNOTATION.haloColor,
        imageUrl: a.imageUrl,
        sizePx: a.sizePx,
        widthPx: a.widthPx,
        fillColor: a.color,
        fillOpacity: a.fillOpacity,
        dashed: a.dashed,
      })) as Annotation[];
    if (audio) compiled.audio = audio.track;
    return compiled;
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
    audio,
    pin,
    pinOverrides,
    regions,
    annotations,
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
    // Exposed for e2e: the compiled scene is the only place to verify that a
    // control actually changed the render rather than just the UI.
    window.__mmProject = project ?? undefined;
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

    // The funnel starts here. `from_link` separates people who arrived on
    // someone else's map from people starting cold — they behave completely
    // differently and averaging them together hides both.
    initAnalytics();
    track('editor_opened', {
      from_link: params.has('s'),
      stops: initial.stops.length,
      format: initial.format,
      style: initialStyle.id,
      zoom_preset: initial.camera.zoomPreset,
      viewport: window.innerWidth < 900 ? 'narrow' : 'wide',
    });

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
        // The exporter reads this canvas back with drawImage() after awaiting
        // a settle, which is a different task from the one that rendered it.
        // Without this the contents of the drawing buffer at that point are
        // undefined — the headful-style suite documents getting an empty
        // buffer doing exactly this. It could not be made to fail under
        // SwiftShader here, so this is insurance rather than a measured fix,
        // but the failure it insures against is a black or stale frame in a
        // finished export and the measured cost was nil.
        //
        // maxTileCacheZoomLevels was tried here too and reverted: it changed
        // tiles fetched across a six-stop fly-through from 61 to 61.
        canvasContextAttributes: { preserveDrawingBuffer: true },
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
    // Clamp, don't reset. This effect fires on EVERY recompile, and since
    // regions, annotations, camera and audio all recompile the project, a
    // reset here throws the viewer back to the start of the video on every
    // slider nudge — you'd move the tilt to look at something and lose the
    // frame you were looking at. Replacing the trip outright (template,
    // import, library load) resets the playhead explicitly at its own call
    // site, which is where that decision belongs.
    const held = Math.min(playheadRef.current, project.format.durationMs);
    playheadRef.current = held;
    setPlayheadMs(held);

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
        incompleteFrames: res.incompleteFrames,
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
    track('style_changed', { style: def.id });
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
    // Watching the preview is the step between building and exporting; if
    // people export without ever playing, the preview isn't earning its place.
    trackOnce('preview_played', { duration_s: Math.round(proj.format.durationMs / 1000) });
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
      audioPreviewRef.current?.stop();
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    if (playheadRef.current >= proj.format.durationMs - 10) seek(0);
    // Start the music from the same instant. The audio then runs on its own
    // clock rather than being nudged every frame — chasing rAF with
    // AudioBufferSourceNode restarts is what makes web audio stutter.
    audioPreviewRef.current?.start(playheadRef.current, proj.format.durationMs);
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
        audioPreviewRef.current?.stop();
        return;
      }
      seek(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // Keep one preview player alive for the session; swapping its source is
  // cheaper than rebuilding the Web Audio graph, and creating a second
  // AudioContext per import would hit the browser's cap.
  useEffect(() => {
    if (!audioPreviewRef.current) audioPreviewRef.current = new AudioPreview(audio);
    else audioPreviewRef.current.setSource(audio);
  }, [audio]);

  useEffect(() => () => audioPreviewRef.current?.stop(), []);

  const handleAudioSource = (next: AudioSource | null) => {
    audioPreviewRef.current?.stop();
    setAudio(next);
    if (next) {
      trackOnce('project_edited', { via: 'audio' });
      track('audio_added', {
        // Duration and tempo, never the file name — that is the user's, and
        // it is usually the artist and title.
        duration_s: Math.round(next.track.durationMs / 1000),
        bpm: next.track.bpm,
        beats: next.track.beats.length,
        confidence: Math.round(next.analysis.confidence * 100) / 100,
      });
    }
  };

  const handleTrackChange = (t: AudioTrack) => {
    audioPreviewRef.current?.stop();
    setAudio((prev) => (prev ? { ...prev, track: t } : prev));
  };

  /**
   * Round every dwell and travel leg to a whole number of beats.
   *
   * Reads the durations back out of the COMPILED project rather than from
   * the options, so what gets quantised is what actually rendered — speed
   * multiplier, per-segment overrides and clamps already applied. Writing
   * the results into the same legDurations/stopDwells that Studio mode edits
   * means the result is inspectable and undoable, not a hidden mode.
   */
  const snapToBeat = () => {
    const proj = projectRef.current;
    const beats = audio?.track.beats;
    if (!proj || !beats?.length) return;
    // Prefer the estimator's sub-frame period; the median gap between beats
    // is quantised to analysis frames and drifts audibly over a long video.
    const period = audio?.track.periodMs ?? beatPeriodMs(beats);
    if (period === null) return;

    const { dwells, legs } = tripSegments(proj);
    // Legs get at least a whole beat; a half-beat flight is a blink.
    setStopDwells(quantiseDurations(dwells, period, { minBeats: 0.5 }));
    setLegDurations(quantiseDurations(legs, period, { minBeats: 1 }));
    // Trim the intro so the first cut lands on a beat rather than a fraction
    // of one after it — quantising fixes the rhythm but not the phase.
    setAudio((prev) =>
      prev
        ? { ...prev, track: { ...prev.track, offsetMs: Math.round(beats[0] ?? 0) } }
        : prev,
    );
    setMode('studio');
    track('beat_snapped', { bpm: audio?.track.bpm ?? null, segments: dwells.length + legs.length });
  };

  /**
   * Placement.
   *
   * The map is constructed with `interactive: false` — that is what makes
   * preview and export pixel-identical, since nothing can pan or zoom it
   * except the engine. So clicks can't come from MapLibre's own handlers.
   * Instead a transparent overlay sits over the preview and unprojects the
   * click itself, which keeps the map inert and still gives us coordinates.
   */
  const startPlacing = (kind: AnnotationKind) => {
    const next = [...annotations, newAnnotation(kind)];
    setAnnotations(next);
    setPlacing(next.length - 1);
    setSelectedAnnotation(next.length - 1);
    setActivePanel('annotate');
    trackOnce('annotation_added', { kind });
  };

  const cancelPlacing = () => {
    // An annotation that never got its clicks has no geometry and would sit
    // in the list doing nothing, so it goes with the cancellation.
    setAnnotations((prev) =>
      prev.filter(
        (a, i) =>
          i !== placing || a.coordinates.length >= (annotationSpec(a.kind)?.points ?? 1),
      ),
    );
    setPlacing(null);
  };

  const placeAt = (clientX: number, clientY: number) => {
    const map = mapRef.current;
    const frame = containerRef.current;
    if (map == null || frame == null || placing === null) return;

    const rect = frame.getBoundingClientRect();
    // The preview is CSS-scaled, so screen pixels have to be divided back out
    // before unproject sees them — otherwise every placement lands short of
    // the cursor by a factor of the zoom-to-fit.
    const x = (clientX - rect.left) / scale;
    const y = (clientY - rect.top) / scale;
    const at = map.unproject([x, y]);
    const coordinate: LngLat = [at.lng, at.lat];

    setAnnotations((prev) => {
      const next = [...prev];
      const target = next[placing];
      if (!target) return prev;
      const needed = annotationSpec(target.kind)?.points ?? 1;
      const coords = [...target.coordinates, coordinate].slice(-needed);
      next[placing] = { ...target, coordinates: coords };
      if (coords.length >= needed) {
        // Done. Show it: an annotation entering at 0 is invisible at playhead
        // 0, so the click would otherwise appear to do nothing.
        setPlacing(null);
        const dur = projectRef.current?.format.durationMs ?? 0;
        setTimeout(() => seek(Math.min(dur, target.enterAt * dur + 700)), 120);
      }
      return next;
    });
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
    track('export_started', {
      format: exportFormat,
      duration_s: Math.round(proj.format.durationMs / 100) / 10,
      width: proj.format.width,
      height: proj.format.height,
      stops: stops.length,
      style: styleRef.current.id,
    });
    try {
      const s = styleRef.current;
      const res = await exportVideo(map, applier, proj, {
        format: exportFormat,
        watermark: 'MAPMOTION',
        attribution: s.attribution,
        settleCapMs: s.settleCapMs,
        audio,
        onProgress: (done, total) => setProgress(done / total),
      });
      setResult(res);
      // Exposed for e2e: the outcome the user is shown, in a form a test can
      // assert on without scraping the DOM.
      window.__exportResult = { ...res, blob: undefined };
      setDownloadUrl(URL.createObjectURL(res.blob));
      // The one number that matters. `realtime_factor` is here because the
      // export-speed claim is a pricing argument and needs field evidence.
      track('export_completed', {
        format: exportFormat,
        codec: res.codec,
        audio: res.audio,
        frames: res.frames,
        bytes: res.blob.size,
        wall_s: Math.round(res.wallMs / 100) / 10,
        realtime_factor: Math.round(res.realtimeFactor * 100) / 100,
        // A count, not content. If this is routinely non-zero in the field it
        // means the default settle budget is wrong for real connections, and
        // that is not something reasoning from a localhost test server can
        // tell us.
        incomplete_frames: res.incompleteFrames,
      });
    } catch (e) {
      setError(String(e));
      track('export_failed', {
        format: exportFormat,
        // Our own error strings and browser exceptions — never anything the
        // user typed. Truncated so a stack trace can't ride along.
        reason: String(e).slice(0, 120),
      });
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

  /** Marker overrides are positional too, and move with their stop. */
  const editPinOverrides = (
    fn: (prev: (Partial<PinAppearance> | null)[]) => (Partial<PinAppearance> | null)[],
  ) => setPinOverrides(fn);

  const setStopZoom = (i: number, zoom: number | null) =>
    editStopZooms((prev) => {
      const next = [...prev];
      while (next.length < stops.length) next.push(null);
      next[i] = zoom;
      return next;
    });

  const addStop = (hit: PlaceHit) => {
    // Once per session: the funnel step is "did they make it theirs at all",
    // not how many stops they added. Firing per keystroke would swamp it.
    trackOnce('project_edited', { via: 'search' });
    // Population is a proxy for "famous city vs obscure place" — it tells us
    // whether the bundled index is enough or people are reaching for the
    // long tail, without recording anywhere anyone actually searched for.
    track('place_searched', { has_population: hit.population > 0 });
    setStops((prev) => [...prev, { name: hit.name, coordinate: hit.coordinate }]);
    setLegModes((prev) => [...prev, 'air']);
    setTrackGeometries((prev) => [...prev, null]);
    setLegDurations((prev) => [...prev, null]);
    editStopZooms((prev) => [...prev, null]);
    editPinOverrides((prev) => [...prev, null]);
  };

  const removeStop = (i: number) => {
    setStops((prev) => prev.filter((_, j) => j !== i));
    editStopZooms((prev) => prev.filter((_, j) => j !== i));
    editPinOverrides((prev) => prev.filter((_, j) => j !== i));
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
    editPinOverrides((prev) => {
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
    trackOnce('project_edited', { via: 'import' });
    track('track_imported', {
      points: t.track.length,
      waypoints: t.waypoints.length,
    });
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
    editPinOverrides(() => []);
    playheadRef.current = 0;
    setPlayheadMs(0);
  };

  /**
   * A folder of photos becomes the whole project: stops in the order they
   * were taken, and each stop's marker is the photograph itself.
   *
   * Replaces rather than appends. Someone dropping their holiday folder is
   * starting a project, not adding to the Bangkok-Tokyo demo, and merging the
   * two would produce a trip nobody took.
   */
  const importPhotoTrip = (result: ImportedPhotos) => {
    setStops(result.stops.map((s) => ({ ...s, coordinate: [...s.coordinate] as LngLat })));
    const legs = Math.max(0, result.stops.length - 1);
    setLegModes(Array.from({ length: legs }, () => 'air' as LegMode));
    setTrackGeometries(Array.from({ length: legs }, () => null));
    setLegDurations(Array.from({ length: legs }, () => null));
    setStopDwells([]);
    editStopZooms(() => []);
    editPinOverrides(() =>
      result.thumbnails.map((url) =>
        url ? { style: 'image' as const, imageUrl: url } : null,
      ),
    );
    setSelected(null);
    playheadRef.current = 0;
    setPlayheadMs(0);
    trackOnce('project_edited', { via: 'photos' });
    track('photos_imported', {
      // Counts only — never a file name, a coordinate or a place name.
      photos: result.summary.total,
      located: result.summary.located,
      no_gps: result.summary.noGps,
      heic: result.summary.heic,
      stops: result.stops.length,
    });
  };

  const handleSave = (name: string) => {
    track('project_saved', { stops: stops.length });
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
    trackOnce('project_edited', { via: 'template' });
    // Template ids are ours, not user content — safe to send verbatim, and
    // knowing which one people start from is the cheapest content signal
    // we have.
    track('template_applied', { template: id });
    setStops(tpl.stops.map((x) => ({ ...x, coordinate: [...x.coordinate] as LngLat })));
    setLegModes([...tpl.legModes]);
    setTrackGeometries(tpl.legModes.map(() => null));
    setLegDurations(tpl.legModes.map(() => null));
    setStopDwells([]);
    editStopZooms(() => []);
    editPinOverrides(() => []);
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

  const segments = project ? tripSegments(project) : { dwells: [], legs: [] };

  const header = (
    <>
      <h1 style={{ margin: 0, fontSize: 16, letterSpacing: -0.2 }}>Mapmotion</h1>
      <div style={{ display: 'flex', gap: 4 }}>
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
      <button
        data-testid="copy-link"
        onClick={() => {
          void navigator.clipboard?.writeText(location.href);
          track('link_copied', { stops: stops.length, style: styleId });
          setCopied(true);
        }}
        style={{ ...btn, marginLeft: 'auto', padding: '5px 11px', fontSize: 12 }}
      >
        {copied ? 'Link copied ✓' : 'Share link'}
      </button>
    </>
  );

  const panels = [
    {
      id: 'trip',
      label: 'Trip',
      glyph: '🗺',
      hint: 'Stops, routes and imports',
      badge: stops.length || null,
      content: (
        <>
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
                  style={{ ...btn, padding: '5px 10px', fontSize: 11, borderRadius: 999 }}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
          <PlaceSearch onPick={addStop} />
          <PhotoImport onImport={importPhotoTrip} disabled={exporting} />
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
        </>
      ),
    },
    {
      id: 'style',
      label: 'Style',
      glyph: '🎨',
      hint: 'Markers, basemap and labels',
      content: (
        <>
          <div>
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
              <span style={{ fontSize: 10, opacity: 0.55, minWidth: 26 }}>{pin.size.toFixed(1)}×</span>
            </div>
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

          <AppearancePanel
            appearance={appearance}
            onChange={setAppearance}
            layerCounts={layerCounts}
            disabled={exporting}
          />
        </>
      ),
    },
    {
      id: 'camera',
      label: 'Camera',
      glyph: '🎥',
      hint: 'Framing, arc, tilt, rotation',
      content: (
        <CameraPanel
          camera={camera}
          onChange={(next) => {
            // Once per session, and with the setting names only — sliders
            // fire continuously and per-tick events would drown the funnel.
            trackOnce('camera_changed', { preset: next.zoomPreset, mode: next.bearingMode });
            setCamera(next);
          }}
          pitch={appearance.pitch}
          onPitchChange={(deg) => setAppearance((a) => ({ ...a, pitch: deg }))}
          disabled={exporting}
        />
      ),
    },
    {
      id: 'regions',
      label: 'Regions',
      glyph: '▣',
      hint: 'Highlight countries and groups',
      badge: regions.length || null,
      content: (
        <RegionPanel
          regions={regions}
          onChange={(next) => {
            const added = next.length > regions.length ? next[next.length - 1] : null;
            if (added) trackOnce('region_added', { count: next.length });
            setRegions(next);
            if (added) {
              // A highlight fades in from its entrance, so at playhead 0 a
              // newly added one is invisible — you'd add it and see nothing
              // change. Move the preview to just past its entrance so the
              // result of the click is the thing you're looking at.
              const dur = projectRef.current?.format.durationMs ?? 0;
              const target = Math.min(dur, added.enterAt * dur + 900);
              // One tick, so the recompiled project is in place first.
              setTimeout(() => seek(target), 120);
            }
          }}
          disabled={exporting}
        />
      ),
    },
    {
      id: 'annotate',
      label: 'Notes',
      glyph: '✎',
      hint: 'Text, arrows and shapes on the map',
      badge: annotations.length || null,
      content: (
        <AnnotatePanel
          annotations={annotations}
          onChange={setAnnotations}
          placing={placing}
          onStartPlacing={startPlacing}
          onCancelPlacing={cancelPlacing}
          selected={selectedAnnotation}
          onSelect={setSelectedAnnotation}
          disabled={exporting}
        />
      ),
    },
    {
      id: 'audio',
      label: 'Audio',
      glyph: '♪',
      hint: 'Soundtrack and beat snapping',
      badge: audio ? '•' : null,
      content: (
        <AudioPanel
          source={audio}
          onSource={handleAudioSource}
          onTrackChange={handleTrackChange}
          onSnapToBeat={snapToBeat}
          playheadMs={playheadMs}
          videoDurationMs={project?.format.durationMs ?? 1}
          disabled={exporting}
        />
      ),
    },
    {
      id: 'titles',
      label: 'Titles',
      glyph: 'T',
      hint: 'Opening and closing cards',
      badge: title ? '•' : null,
      content: (
        <div>
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
      ),
    },
    {
      id: 'output',
      label: 'Output',
      glyph: '⤓',
      hint: 'Format, speed and saved projects',
      content: (
        <>
          <div>
            <Label>Format</Label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(Object.keys(FORMATS) as FormatId[]).map((f) => (
                <button
                  key={f}
                  data-testid={`format-${f}`}
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

          <ProjectLibrary
            onLoad={handleLoad}
            onSave={handleSave}
            currentName={title || savedAs || ''}
            reloadKey={libraryKey}
          />
        </>
      ),
    },
  ];

  const stage = (
    <div ref={previewRef} style={{ minWidth: 0 }}>
      <div
        data-testid="preview-frame"
        style={{
          position: 'relative',
          width: dims.width * scale,
          height: dims.height * scale,
          maxWidth: '100%',
          // A vertical format leaves slack on both sides; hugging the left
          // edge looks like a bug rather than a choice.
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
        {placing !== null && (
          <div
            data-testid="placement-overlay"
            onClick={(e) => placeAt(e.clientX, e.clientY)}
            style={{
              position: 'absolute',
              inset: 0,
              cursor: 'crosshair',
              // Faintest possible tint: enough to signal the mode without
              // changing what the map looks like while you aim.
              background: 'rgba(232,89,12,0.06)',
              zIndex: 3,
            }}
          />
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
          marginTop: 12,
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
            audioPreviewRef.current?.stop();
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
          {result.frames} frames · {result.codec}
          {result.audio === 'included' && ' + audio'} · {(result.blob.size / 1e6).toFixed(1)} MB ·{' '}
          {(result.wallMs / 1000).toFixed(1)}s ({result.realtimeFactor.toFixed(2)}× realtime) ·{' '}
          <a href={downloadUrl} download={`mapmotion.${result.ext}`} style={{ color: '#74c0fc' }}>
            download .{result.ext}
          </a>
          {result.audio !== 'included' && result.audio !== 'none' && (
            <span data-testid="audio-outcome" style={{ color: '#ffc078', display: 'block', fontSize: 12, marginTop: 2 }}>
              {result.audio === 'unsupported-format'
                ? 'GIF has no audio track — export as MP4 to keep the music.'
                : result.audio === 'unsupported-encoder'
                  ? 'This browser has no audio encoder, so the video is silent. Chrome or Edge will include it.'
                  : 'The soundtrack could not be encoded, so the video is silent.'}
            </span>
          )}
          {result.incompleteFrames > 0 && (
            <span
              data-testid="incomplete-frames"
              style={{ color: '#ffc078', display: 'block', fontSize: 12, marginTop: 2 }}
            >
              {result.incompleteFrames} of {result.frames} frames were captured before the
              map finished loading and may show gaps. A faster connection, or a simpler map
              style, will fix it.
            </span>
          )}
        </p>
      )}
    </div>
  );

  return (
    <EditorShell
      panels={panels}
      header={header}
      stage={stage}
      narrow={narrow}
      activeId={activePanel}
      onActivate={setActivePanel}
      storyboard={
        <Storyboard
          stops={stops}
          dwells={segments.dwells}
          legs={segments.legs}
          thumbnails={pinOverrides}
          selected={selected}
          playheadMs={playheadMs}
          onSelect={(sel) => {
            setSelected(sel);
            // Selecting a stop should take you to the controls for it, not
            // leave you to work out which tab they live in.
            if (sel) setActivePanel('trip');
          }}
          onSeek={seek}
        />
      }
    />
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
