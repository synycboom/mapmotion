'use client';

import {
  DEFAULT_AUDIO,
  analyseBeats,
  audioGainAt,
  sourceTimeAt,
  type AudioTrack,
  type BeatAnalysis,
} from '@mapmotion/engine';

/**
 * Decoded audio, kept out of the project.
 *
 * `AudioBuffer` is tens of megabytes and not serialisable, so the project
 * carries only the AudioTrack metadata (timings, gain, beats) while the
 * samples live here for the session. That split is what lets a project stay
 * a URL and a localStorage entry.
 */
export interface AudioSource {
  buffer: AudioBuffer;
  /** Mono mixdown, kept for waveform drawing and export encoding. */
  mono: Float32Array;
  track: AudioTrack;
  analysis: BeatAnalysis;
}

/** Anything a browser can plausibly decode. */
export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac';

/** Bigger than this and decoding stalls the tab for seconds. */
export const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

let ctx: AudioContext | null = null;

/** One shared AudioContext — browsers cap how many you may create. */
export function audioContext(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * Analysis sample rate.
 *
 * Beat detection cares about energy over ~10ms windows, so 22.05kHz loses
 * nothing and roughly halves the work. On a phone the difference between
 * analysing a four-minute track at 44.1k and 22.05k is the difference between
 * a noticeable freeze and none.
 */
const ANALYSIS_RATE = 22050;

export interface DecodeResult {
  source?: AudioSource;
  error?: string;
}

/**
 * Decode a file, mix to mono, and find the beat.
 *
 * Everything happens locally — the file is never uploaded, same as GPX
 * import. That is worth keeping true: people score these with music they
 * don't have distribution rights to, and it is not our business.
 */
export async function decodeAudioFile(file: File): Promise<DecodeResult> {
  if (file.size > MAX_AUDIO_BYTES) {
    return { error: `That file is ${(file.size / 1e6).toFixed(0)} MB; the limit is ${MAX_AUDIO_BYTES / 1e6} MB.` };
  }

  let buffer: AudioBuffer;
  try {
    const bytes = await file.arrayBuffer();
    buffer = await audioContext().decodeAudioData(bytes);
  } catch {
    return { error: 'That file could not be decoded — try MP3, M4A, WAV or OGG.' };
  }

  if (!buffer.length || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    return { error: 'That file decoded to no audio.' };
  }

  const mono = downmix(buffer);
  const analysis = analyseBeats(downsample(mono, buffer.sampleRate, ANALYSIS_RATE), ANALYSIS_RATE);

  return {
    source: {
      buffer,
      mono,
      analysis,
      track: {
        ...DEFAULT_AUDIO,
        name: file.name,
        durationMs: buffer.duration * 1000,
        beats: analysis.beats,
        bpm: analysis.bpm,
        periodMs: analysis.periodMs,
      },
    },
  };
}

/** Average the channels. Beat detection on one channel misses hard-panned hits. */
function downmix(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i]! += data[i]!;
  }
  if (buffer.numberOfChannels > 1) {
    for (let i = 0; i < n; i++) out[i]! /= buffer.numberOfChannels;
  }
  return out;
}

/**
 * Decimate to a lower rate by averaging, not by picking every Nth sample.
 *
 * Point-sampling would alias high frequencies down into the range the onset
 * detector reads as transients, inventing onsets that aren't there. Averaging
 * is a crude anti-alias filter, but a crude one is the difference between a
 * usable envelope and noise.
 */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/**
 * Preview playback, kept in sync with the animation playhead.
 *
 * Deliberately not a general audio engine: start at a video time, stop, done.
 * Scrubbing does not play audio, because a Web Audio graph restarted on every
 * pointer move sounds like a machine gun.
 */
export class AudioPreview {
  private node: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;

  constructor(private source: AudioSource | null) {}

  setSource(source: AudioSource | null): void {
    if (source !== this.source) this.stop();
    this.source = source;
  }

  /** Begin playback as if the video were at `videoMs`. */
  start(videoMs: number, videoDurationMs: number): void {
    this.stop();
    const src = this.source;
    if (!src) return;

    const at = sourceTimeAt(src.track, videoMs);
    if (at === null) return;

    try {
      const context = audioContext();
      // Browsers suspend the context until a user gesture; Play is one.
      void context.resume();

      const node = context.createBufferSource();
      node.buffer = src.buffer;
      const gain = context.createGain();
      gain.gain.value = audioGainAt(src.track, videoMs, videoDurationMs);
      node.connect(gain).connect(context.destination);

      // Schedule the fade-out on the audio clock rather than driving it from
      // rAF — a dropped frame during export or a busy main thread would
      // otherwise leave the tail at full volume.
      const fade = Math.max(0, src.track.fadeOutMs);
      const remaining = (videoDurationMs - videoMs) / 1000;
      if (fade > 0 && remaining > 0) {
        const fadeStart = Math.max(0, remaining - fade / 1000);
        gain.gain.setValueAtTime(gain.gain.value, context.currentTime + fadeStart);
        gain.gain.linearRampToValueAtTime(0.0001, context.currentTime + remaining);
      }

      node.start(0, at / 1000);
      this.node = node;
      this.gainNode = gain;
    } catch {
      /* audio is a nicety; never let it stop the preview */
    }
  }

  stop(): void {
    try {
      this.node?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.node?.disconnect();
      this.gainNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.node = null;
    this.gainNode = null;
  }
}

/**
 * Render the exact audio the export should contain.
 *
 * Offset, gain, fade-out, trimming to the video length and resampling all
 * happen in one OfflineAudioContext render. Doing it by hand would mean
 * writing a resampler, and a bad resampler is audible in a way a bad
 * anything-else in this codebase is not — the browser already has a good one.
 *
 * Returns null when there is nothing to render, so callers can fall through
 * to a silent export rather than special-casing.
 */
export async function renderExportAudio(
  source: AudioSource,
  videoDurationMs: number,
  targetRate: number,
): Promise<AudioBuffer | null> {
  const { buffer, track } = source;
  const durationSec = videoDurationMs / 1000;
  const frames = Math.floor(durationSec * targetRate);
  if (frames <= 0) return null;

  const startSec = Math.max(0, track.offsetMs / 1000);
  if (startSec >= buffer.duration) return null;

  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));

  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const offline = new Ctor(channels, frames, targetRate);

  const node = offline.createBufferSource();
  node.buffer = buffer;
  const gain = offline.createGain();
  const level = Math.min(1, Math.max(0, track.gain));
  gain.gain.setValueAtTime(level, 0);

  const fadeSec = Math.max(0, track.fadeOutMs) / 1000;
  if (fadeSec > 0 && fadeSec < durationSec) {
    gain.gain.setValueAtTime(level, durationSec - fadeSec);
    // Ramp to a tiny value rather than 0: an exponential ramp to zero is
    // undefined, and a linear one to exactly zero can click on some engines.
    gain.gain.linearRampToValueAtTime(0.0001, durationSec);
  }

  node.connect(gain).connect(offline.destination);
  // Everything past the end of the source is simply silence — the track runs
  // out rather than looping, which is the behaviour the panel warns about.
  node.start(0, startSec);

  return offline.startRendering();
}

/** Interleaved planar copy of an AudioBuffer, as WebCodecs' AudioData wants. */
export function planarFrom(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length * channels);
  for (let c = 0; c < channels; c++) {
    out.set(buffer.getChannelData(c), c * buffer.length);
  }
  return out;
}
