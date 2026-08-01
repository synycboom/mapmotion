import type { Map as MLMap } from 'maplibre-gl';
import { sceneAt, type Project } from '@mapmotion/engine';
import { drawTitles } from './drawTitles';
import type { FrameApplier } from './applyFrame';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { planarFrom, renderExportAudio, type AudioSource } from './audioSource';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export type ExportFormat = 'video' | 'gif';

/**
 * What happened to the soundtrack.
 *
 * Reported rather than silently decided, because "my music is missing" with
 * no explanation is a support ticket, and the honest answers differ: GIF has
 * no audio track at all, and a browser without an AudioEncoder can't make one.
 */
export type AudioOutcome =
  | 'none'
  | 'included'
  | 'unsupported-format'
  | 'unsupported-encoder'
  | 'failed';

export interface ExportResult {
  blob: Blob;
  ext: 'mp4' | 'webm' | 'gif';
  codec: string;
  frames: number;
  wallMs: number;
  msPerFrame: number;
  realtimeFactor: number; // wall time / video duration; 1 = realtime
  audio: AudioOutcome;
  /** Audio codec actually used, when one was. */
  audioCodec?: string;
}

export interface ExportOptions {
  /** 'video' (H.264/VP9) or 'gif'. */
  format?: ExportFormat;
  /** GIF only: cap the frame rate, since GIF at 30fps is enormous. */
  gifFps?: number;
  watermark?: string;
  /** Attribution line composited into every frame (OSM license requires it). */
  attribution?: string;
  /** Per-frame settle budget; remote-tile styles need more than local GeoJSON. */
  settleCapMs?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Decoded soundtrack. Kept separate from the Project because the samples
   * are megabytes and the Project has to stay serialisable.
   */
  audio?: AudioSource | null;
}

interface CodecChoice {
  codec: string;
  ext: 'mp4' | 'webm';
  container: 'mp4' | 'webm';
}

/**
 * Deterministic frame-stepped export:
 *   for each frame i: apply sceneAt(project, i/fps) -> wait for map to settle
 *   -> composite onto 2D canvas (+watermark) -> VideoEncoder -> muxer.
 *
 * Tries H.264 (mp4) first, falls back to VP9/VP8 (webm) — headless/OSS
 * Chromium builds often lack the H.264 encoder.
 */
export async function exportVideo(
  map: MLMap,
  applier: FrameApplier,
  project: Project,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  if (opts.format === 'gif') return exportGif(map, applier, project, opts);

  const { width, height, fps, durationMs } = project.format;
  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));

  const choice = await pickCodec(width, height, fps);
  if (!choice) throw new Error('WebCodecs: no supported video encoder found');

  const isMp4 = choice.container === 'mp4';
  const mp4Target = new Mp4Target();
  const webmTarget = new WebmTarget();

  // Audio has to be resolved BEFORE the muxer exists: a track can only be
  // declared at construction, so discovering later that the encoder is
  // missing would mean throwing the file away and starting again.
  const audioPlan = await planAudio(opts.audio ?? null, isMp4, durationMs);

  const muxer = isMp4
    ? new Mp4Muxer({
        target: mp4Target,
        video: { codec: 'avc', width, height },
        ...(audioPlan.ok
          ? {
              audio: {
                codec: 'aac' as const,
                numberOfChannels: audioPlan.channels,
                sampleRate: audioPlan.sampleRate,
              },
            }
          : {}),
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
      })
    : new WebmMuxer({
        target: webmTarget,
        video: {
          codec: choice.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
          width,
          height,
          frameRate: fps,
        },
        ...(audioPlan.ok
          ? {
              audio: {
                codec: 'A_OPUS',
                numberOfChannels: audioPlan.channels,
                sampleRate: audioPlan.sampleRate,
              },
            }
          : {}),
        firstTimestampBehavior: 'offset',
      });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta as never),
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: choice.codec,
    width,
    height,
    framerate: fps,
    bitrate: bitrateFor(width, height, fps),
    latencyMode: 'quality',
  });

  // Compositing canvas: map frame + watermark + attribution.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;

  const mapCanvas = map.getCanvas();
  const t0 = performance.now();
  const settleCapMs = opts.settleCapMs ?? 900;

  // Encode the whole soundtrack up front. It takes well under a second even
  // for a minute of audio, and doing it first means a failure here costs
  // nothing — the video loop hasn't started yet.
  let audioOutcome = audioPlan.outcome;
  if (audioPlan.ok) {
    try {
      await encodeAudio(audioPlan, muxer);
      audioOutcome = 'included';
    } catch {
      // A silent video is a far better outcome than no video.
      audioOutcome = 'failed';
    }
  }

  // Vehicle sprites are rasterised on demand; make sure every one this
  // project needs exists BEFORE the first captured frame, or early frames
  // would render without their vehicle.
  await applier.ensureIcons();

  // Pre-warm: seek to t=0 and give initial sources/glyphs time to load.
  applier.apply(sceneAt(project, 0));
  await settle(map, Math.max(4000, settleCapMs * 3));

  for (let i = 0; i < totalFrames; i++) {
    if (opts.signal?.aborted) throw new Error('export aborted');
    if (encoderError) throw encoderError;

    const tMs = (i / fps) * 1000;
    const frame = sceneAt(project, tMs);
    applier.apply(frame);
    await settle(map, settleCapMs);

    ctx.drawImage(mapCanvas, 0, 0, width, height);
    // Same function the preview uses, so titles land identically.
    drawTitles(ctx, frame.titles, width, height);
    drawOverlays(ctx, width, height, opts.watermark, opts.attribution);

    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    });
    encoder.encode(videoFrame, { keyFrame: i % (fps * 2) === 0 });
    videoFrame.close();

    // Backpressure: don't let the encode queue grow unbounded.
    while (encoder.encodeQueueSize > 4) await sleep(2);

    opts.onProgress?.(i + 1, totalFrames);
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const buffer = isMp4 ? mp4Target.buffer : webmTarget.buffer;
  const wallMs = performance.now() - t0;

  return {
    blob: new Blob([buffer], { type: isMp4 ? 'video/mp4' : 'video/webm' }),
    ext: choice.ext,
    codec: choice.codec,
    frames: totalFrames,
    wallMs,
    msPerFrame: wallMs / totalFrames,
    realtimeFactor: wallMs / durationMs,
    audio: audioOutcome,
    audioCodec: audioPlan.ok ? audioPlan.codec : undefined,
  };
}

interface AudioPlan {
  ok: boolean;
  outcome: AudioOutcome;
  codec: string;
  sampleRate: number;
  channels: number;
  buffer: AudioBuffer | null;
}

const NO_AUDIO: AudioPlan = {
  ok: false,
  outcome: 'none',
  codec: '',
  sampleRate: 48000,
  channels: 2,
  buffer: null,
};

/**
 * Decide whether this export can carry audio, and render it if so.
 *
 * 48kHz throughout: Opus only speaks 48k, and AAC is happy there, so one rate
 * avoids a second resampling path that would exist purely to save nothing.
 */
async function planAudio(
  source: AudioSource | null,
  isMp4: boolean,
  durationMs: number,
): Promise<AudioPlan> {
  if (!source) return NO_AUDIO;
  if (typeof AudioEncoder === 'undefined') {
    return { ...NO_AUDIO, outcome: 'unsupported-encoder' };
  }

  const sampleRate = 48000;
  const codec = isMp4 ? 'mp4a.40.2' : 'opus';
  const channels = Math.min(2, Math.max(1, source.buffer.numberOfChannels));

  try {
    const { supported } = await AudioEncoder.isConfigSupported({
      codec,
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    });
    if (!supported) return { ...NO_AUDIO, outcome: 'unsupported-encoder' };
  } catch {
    return { ...NO_AUDIO, outcome: 'unsupported-encoder' };
  }

  const rendered = await renderExportAudio(source, durationMs, sampleRate);
  if (!rendered) return NO_AUDIO;

  return { ok: true, outcome: 'included', codec, sampleRate, channels, buffer: rendered };
}

/** AAC wants 1024-frame blocks; Opus is happy with them too. */
const AUDIO_BLOCK = 1024;

async function encodeAudio(
  plan: AudioPlan,
  muxer: {
    addAudioChunk: (
      chunk: EncodedAudioChunk,
      meta?: EncodedAudioChunkMetadata,
      timestamp?: number,
    ) => void;
  },
): Promise<void> {
  const buffer = plan.buffer!;
  const planar = planarFrom(buffer);
  const total = buffer.length;
  const channels = buffer.numberOfChannels;

  let error: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      error = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: plan.codec,
    sampleRate: plan.sampleRate,
    numberOfChannels: channels,
    bitrate: 128_000,
  });

  for (let offset = 0; offset < total; offset += AUDIO_BLOCK) {
    if (error) throw error;
    const frames = Math.min(AUDIO_BLOCK, total - offset);
    // AudioData takes planar data as one buffer with the channels laid end to
    // end, so each channel's slice has to be copied into the right region.
    const block = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
      block.set(planar.subarray(c * total + offset, c * total + offset + frames), c * frames);
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: plan.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((offset / plan.sampleRate) * 1e6),
      data: block,
    });
    encoder.encode(data);
    data.close();
    while (encoder.encodeQueueSize > 8) await sleep(1);
  }

  await encoder.flush();
  encoder.close();
  if (error) throw error;
}

async function pickCodec(
  width: number,
  height: number,
  fps: number,
): Promise<CodecChoice | null> {
  const candidates: CodecChoice[] = [
    // H.264 High profile — level chosen generously for 1080p60.
    { codec: 'avc1.640033', ext: 'mp4', container: 'mp4' },
    { codec: 'avc1.42003d', ext: 'mp4', container: 'mp4' },
    { codec: 'vp09.00.10.08', ext: 'webm', container: 'webm' },
    { codec: 'vp8', ext: 'webm', container: 'webm' },
  ];
  for (const c of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width,
        height,
        framerate: fps,
        bitrate: bitrateFor(width, height, fps),
      });
      if (supported) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function bitrateFor(width: number, height: number, fps: number): number {
  // ~0.12 bits per pixel per frame, clamped to sane bounds.
  const bps = width * height * fps * 0.12;
  return Math.min(20_000_000, Math.max(1_000_000, Math.round(bps)));
}

/**
 * Wait until the map has re-rendered and settled after a jumpTo/setData.
 * GeoJSON-only styles settle almost immediately; remote glyphs/tiles get up
 * to `capMs`. The cap keeps a lost network request from stalling the export.
 */
function settle(map: MLMap, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, capMs);
    map.once('idle', finish);
    map.triggerRepaint();
  });
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  watermark?: string,
  attribution?: string,
) {
  const pad = Math.round(width * 0.012);
  ctx.save();
  // Attribution (kept on all tiers — data licensing).
  ctx.font = `${Math.max(11, Math.round(width / 160))}px sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  const attr = attribution ?? 'Data: Natural Earth';
  const y = height - pad;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeText(attr, pad, y);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(attr, pad, y);

  if (watermark) {
    ctx.textAlign = 'right';
    ctx.font = `600 ${Math.max(14, Math.round(width / 70))}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(watermark, width - pad, height - pad);
  }
  ctx.restore();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GIF export.
 *
 * Shares the identical deterministic frame-stepping and compositing as the
 * video path — the only difference is the encoder. GIF is capped to a lower
 * frame rate by default because the format stores full palettised frames:
 * 30fps GIF is enormous and no better to look at than 12–15fps.
 */
async function exportGif(
  map: MLMap,
  applier: FrameApplier,
  project: Project,
  opts: ExportOptions,
): Promise<ExportResult> {
  const { width, height, fps, durationMs } = project.format;
  const gifFps = Math.min(fps, Math.max(2, opts.gifFps ?? 12));
  // Step through the source timeline at the GIF's own rate.
  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * gifFps));
  const delayMs = Math.round(1000 / gifFps);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const mapCanvas = map.getCanvas();

  const encoder = GIFEncoder();
  const t0 = performance.now();
  const settleCapMs = opts.settleCapMs ?? 900;

  await applier.ensureIcons();
  applier.apply(sceneAt(project, 0));
  await settle(map, Math.max(4000, settleCapMs * 3));

  for (let i = 0; i < totalFrames; i++) {
    if (opts.signal?.aborted) throw new Error('export aborted');

    const tMs = (i / gifFps) * 1000;
    const frame = sceneAt(project, tMs);
    applier.apply(frame);
    await settle(map, settleCapMs);

    ctx.drawImage(mapCanvas, 0, 0, width, height);
    drawTitles(ctx, frame.titles, width, height);
    drawOverlays(ctx, width, height, opts.watermark, opts.attribution);

    const { data } = ctx.getImageData(0, 0, width, height);
    // Per-frame palette: maps change colour a lot across a fly-through, and
    // a single global palette would band badly.
    const palette = quantize(data, 256, { format: 'rgb565' });
    const indexed = applyPalette(data, palette, 'rgb565');
    encoder.writeFrame(indexed, width, height, { palette, delay: delayMs });

    opts.onProgress?.(i + 1, totalFrames);
    // Yield so the progress UI can paint.
    if (i % 4 === 0) await sleep(0);
  }

  encoder.finish();
  const bytes = encoder.bytes();
  const wallMs = performance.now() - t0;

  return {
    blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/gif' }),
    ext: 'gif',
    codec: `gif-${gifFps}fps`,
    frames: totalFrames,
    wallMs,
    msPerFrame: wallMs / totalFrames,
    realtimeFactor: wallMs / durationMs,
    // GIF has no audio track. Saying so beats leaving the user to work out
    // why their soundtrack vanished.
    audio: opts.audio ? 'unsupported-format' : 'none',
  };
}
