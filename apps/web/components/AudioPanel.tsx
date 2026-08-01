'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioTrack } from '@mapmotion/engine';
import {
  AUDIO_ACCEPT,
  MAX_AUDIO_BYTES,
  decodeAudioFile,
  type AudioSource,
} from '../lib/audioSource';

/**
 * Soundtrack: import, waveform, beat grid, and the snap that makes it worth
 * having.
 *
 * No competitor in this category has audio at all, so there is no convention
 * to follow. The bet is that the useful part isn't playing music under a
 * video — any editor can do that — it's cutting the animation to the beat
 * without the user counting frames.
 */
export function AudioPanel({
  source,
  onSource,
  onTrackChange,
  onSnapToBeat,
  playheadMs,
  videoDurationMs,
  disabled,
}: {
  source: AudioSource | null;
  onSource: (s: AudioSource | null) => void;
  onTrackChange: (t: AudioTrack) => void;
  /** Quantise every segment to the beat grid. */
  onSnapToBeat: () => void;
  playheadMs: number;
  videoDurationMs: number;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      // Yield once so the "Analysing…" state paints before decoding blocks
      // the main thread — otherwise a big file looks like a frozen tab.
      await new Promise((r) => setTimeout(r, 16));
      const { source: next, error: err } = await decodeAudioFile(file);
      setBusy(false);
      if (err || !next) {
        setError(err ?? 'Could not read that file.');
        return;
      }
      onSource(next);
    },
    [onSource],
  );

  const track = source?.track;
  const confidence = source?.analysis.confidence ?? 0;

  return (
    <div data-testid="audio-panel" style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 6, letterSpacing: 0.3 }}>
        Soundtrack
      </div>

      {!source && (
        <div
          data-testid="audio-drop"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void load(e.dataTransfer.files?.[0]);
          }}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `1px dashed ${dragging ? '#e8590c' : '#34496b'}`,
            borderRadius: 8,
            padding: '14px 10px',
            textAlign: 'center',
            fontSize: 12,
            cursor: 'pointer',
            background: dragging ? 'rgba(232,89,12,0.08)' : 'transparent',
          }}
        >
          {busy ? 'Analysing…' : 'Add music — drop a file, or click to browse'}
          <div style={{ fontSize: 10, opacity: 0.45, marginTop: 3 }}>
            Stays on your device · MP3, M4A, WAV, OGG · up to {MAX_AUDIO_BYTES / 1e6} MB
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        data-testid="audio-input"
        type="file"
        accept={AUDIO_ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => void load(e.target.files?.[0])}
      />

      {error && (
        <p data-testid="audio-error" style={{ color: '#ff8787', fontSize: 11, margin: '6px 0 0' }}>
          {error}
        </p>
      )}

      {source && track && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span
              data-testid="audio-name"
              style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {track.name}
            </span>
            <button
              data-testid="audio-remove"
              onClick={() => {
                onSource(null);
                setError(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
              disabled={disabled}
              aria-label="Remove the soundtrack"
              style={{
                background: 'transparent',
                border: '1px solid #2c3d5c',
                color: '#ff8787',
                borderRadius: 4,
                fontSize: 11,
                padding: '2px 7px',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>

          <Waveform
            source={source}
            playheadMs={playheadMs}
            videoDurationMs={videoDurationMs}
          />

          <div data-testid="audio-tempo" style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>
            {track.bpm
              ? `${track.bpm} BPM · ${track.beats.length} beats${confidence < 0.45 ? ' · weak pulse, check before snapping' : ''}`
              : 'No clear beat found — snapping is off for this track'}
          </div>

          <button
            data-testid="audio-snap"
            onClick={onSnapToBeat}
            disabled={disabled || !track.bpm}
            title={
              track.bpm
                ? 'Round every dwell and travel leg to a whole number of beats'
                : 'Needs a detectable beat'
            }
            style={{
              width: '100%',
              marginTop: 8,
              background: track.bpm ? '#e8590c' : '#1c2a42',
              border: `1px solid ${track.bpm ? '#e8590c' : '#34496b'}`,
              color: '#e6edf5',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 12,
              cursor: track.bpm ? 'pointer' : 'default',
              opacity: track.bpm ? 1 : 0.5,
            }}
          >
            Cut to the beat
          </button>

          <Slider
            testId="audio-gain"
            label={`Volume · ${Math.round(track.gain * 100)}%`}
            min={0}
            max={1}
            step={0.05}
            value={track.gain}
            disabled={disabled}
            onChange={(v) => onTrackChange({ ...track, gain: v })}
          />
          <Slider
            testId="audio-offset"
            label={`Start at · ${(track.offsetMs / 1000).toFixed(1)}s into the track`}
            min={0}
            max={Math.max(0, track.durationMs - 1000)}
            step={100}
            value={track.offsetMs}
            disabled={disabled}
            onChange={(v) => onTrackChange({ ...track, offsetMs: v })}
          />
          <Slider
            testId="audio-fade"
            label={`Fade out · ${(track.fadeOutMs / 1000).toFixed(1)}s`}
            min={0}
            max={5000}
            step={100}
            value={track.fadeOutMs}
            disabled={disabled}
            onChange={(v) => onTrackChange({ ...track, fadeOutMs: v })}
          />

          {track.durationMs - track.offsetMs < videoDurationMs && (
            <p style={{ fontSize: 10, color: '#ffc078', margin: '6px 0 0' }}>
              The track runs out {((videoDurationMs - (track.durationMs - track.offsetMs)) / 1000).toFixed(1)}s
              before the video ends — it will go silent rather than loop.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Onset envelope with beat ticks and the playhead.
 *
 * Drawn from the analysis envelope rather than the raw samples: a raw
 * waveform of a mastered track is a solid block that tells you nothing about
 * where the hits are, which is the only thing this view is for.
 */
function Waveform({
  source,
  playheadMs,
  videoDurationMs,
}: {
  source: AudioSource;
  playheadMs: number;
  videoDurationMs: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { analysis, track } = source;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // Show the window the video actually uses, not the whole file — the
    // interesting question is "where do the beats fall in my video".
    const startMs = track.offsetMs;
    const endMs = Math.min(track.durationMs, startMs + videoDurationMs);
    const spanMs = Math.max(1, endMs - startMs);
    const xOf = (ms: number) => ((ms - startMs) / spanMs) * w;

    g.fillStyle = '#111c2e';
    g.fillRect(0, 0, w, h);

    const env = analysis.envelope;
    const hz = analysis.envelopeHz;
    g.strokeStyle = '#3d5a86';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const ms = startMs + (x / w) * spanMs;
      const f = Math.round((ms / 1000) * hz);
      // Peak over the frames this pixel covers, so a single sharp hit can't
      // fall between pixels and vanish.
      let peak = 0;
      const span = Math.max(1, Math.round(hz * (spanMs / 1000) / w));
      for (let d = 0; d < span; d++) {
        const v = env[f + d];
        if (v !== undefined && v > peak) peak = v;
      }
      const y = h - peak * (h - 4) - 2;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();

    g.strokeStyle = 'rgba(232,89,12,0.55)';
    for (const b of track.beats) {
      if (b < startMs || b > endMs) continue;
      const x = Math.round(xOf(b)) + 0.5;
      g.beginPath();
      g.moveTo(x, h - 6);
      g.lineTo(x, h);
      g.stroke();
    }

    const playX = xOf(startMs + Math.min(playheadMs, spanMs));
    g.strokeStyle = '#e6edf5';
    g.beginPath();
    g.moveTo(Math.round(playX) + 0.5, 0);
    g.lineTo(Math.round(playX) + 0.5, h);
    g.stroke();
  }, [analysis, track, playheadMs, videoDurationMs]);

  return (
    <canvas
      ref={ref}
      data-testid="audio-waveform"
      style={{ width: '100%', height: 44, marginTop: 6, borderRadius: 4, display: 'block' }}
    />
  );
}

function Slider({
  testId,
  label,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 3 }}>{label}</div>
      <input
        data-testid={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}
