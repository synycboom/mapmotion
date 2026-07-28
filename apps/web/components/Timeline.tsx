'use client';

import { useRef } from 'react';
import type { Project, TripStop } from '@mapmotion/engine';

/**
 * Studio-mode timeline.
 *
 * Quick mode hides time entirely — you pick places and it just works. Studio
 * mode is the "deep on demand" half: the same project, with every segment's
 * duration exposed and editable. Nothing here is a different data model; it
 * edits the same legDurations/stopDwells the compiler already reads, so
 * switching modes never rebuilds or loses anything.
 */
export function Timeline({
  project,
  stops,
  playheadMs,
  legDurations,
  stopDwells,
  selected,
  onSelect,
  onSeek,
  onSetLegDuration,
  onSetStopDwell,
  onReset,
}: {
  project: Project;
  stops: TripStop[];
  playheadMs: number;
  legDurations: (number | null)[];
  stopDwells: (number | null)[];
  selected: { kind: 'leg' | 'stop'; index: number } | null;
  onSelect: (sel: { kind: 'leg' | 'stop'; index: number } | null) => void;
  onSeek: (ms: number) => void;
  onSetLegDuration: (i: number, ms: number | null) => void;
  onSetStopDwell: (i: number, ms: number | null) => void;
  onReset: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const total = Math.max(1, project.format.durationMs);
  const pct = (ms: number) => `${(ms / total) * 100}%`;

  const seekFromEvent = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    onSeek(Math.min(total, Math.max(0, ratio * total)));
  };

  // Dwell blocks sit between route blocks; derive their spans from the
  // compiled project so the timeline always matches what will render.
  const dwellSpans: Array<{ index: number; startMs: number; endMs: number }> = [];
  for (let i = 0; i < stops.length; i++) {
    const prev = project.routes[i - 1];
    const next = project.routes[i];
    const startMs = prev ? prev.endMs : 0;
    const endMs = next ? next.startMs : project.format.durationMs;
    if (endMs > startMs) dwellSpans.push({ index: i, startMs, endMs });
  }

  const sel = selected;
  const selectedDuration =
    sel?.kind === 'leg'
      ? (project.routes[sel.index]!.endMs - project.routes[sel.index]!.startMs)
      : sel?.kind === 'stop'
        ? (dwellSpans.find((d) => d.index === sel.index)?.endMs ?? 0) -
          (dwellSpans.find((d) => d.index === sel.index)?.startMs ?? 0)
        : 0;

  const isOverridden =
    sel?.kind === 'leg'
      ? legDurations[sel.index] != null
      : sel?.kind === 'stop'
        ? stopDwells[sel.index] != null
        : false;

  return (
    <div data-testid="timeline" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, opacity: 0.55 }}>Timeline</span>
        <span style={{ fontSize: 10, opacity: 0.4 }}>
          click a block to retime it
        </span>
        <button
          data-testid="reset-timing"
          onClick={onReset}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid #2c3d5c',
            color: '#9fb0c8',
            borderRadius: 4,
            fontSize: 10,
            padding: '3px 8px',
            cursor: 'pointer',
          }}
        >
          Reset timing
        </button>
      </div>

      <div
        ref={trackRef}
        data-testid="timeline-track"
        onMouseDown={(e) => seekFromEvent(e.clientX)}
        style={{
          position: 'relative',
          height: 62,
          background: '#0d1626',
          border: '1px solid #24334d',
          borderRadius: 6,
          overflow: 'hidden',
          cursor: 'text',
          userSelect: 'none',
        }}
      >
        {/* Row 1: stop dwells */}
        {dwellSpans.map((d) => (
          <Block
            key={`stop-${d.index}`}
            testid={`tl-stop-${d.index}`}
            left={pct(d.startMs)}
            width={pct(d.endMs - d.startMs)}
            top={4}
            height={24}
            color={stopDwells[d.index] != null ? '#2f6f4f' : '#24425f'}
            active={sel?.kind === 'stop' && sel.index === d.index}
            label={stops[d.index]?.name ?? ''}
            onClick={() => onSelect({ kind: 'stop', index: d.index })}
          />
        ))}

        {/* Row 2: travel legs */}
        {project.routes.map((r, i) => (
          <Block
            key={r.id}
            testid={`tl-leg-${i}`}
            left={pct(r.startMs)}
            width={pct(r.endMs - r.startMs)}
            top={32}
            height={24}
            color={legDurations[i] != null ? '#a8480c' : '#e8590c'}
            active={sel?.kind === 'leg' && sel.index === i}
            label={`${i + 1} → ${i + 2}`}
            onClick={() => onSelect({ kind: 'leg', index: i })}
          />
        ))}

        {/* Title card spans, as a thin strip along the top */}
        {project.titles.map((t) => (
          <div
            key={t.id}
            title={`Title: ${t.text}`}
            style={{
              position: 'absolute',
              left: pct(t.startMs),
              width: pct(t.endMs - t.startMs),
              top: 0,
              height: 3,
              background: '#ffd43b',
              opacity: 0.9,
            }}
          />
        ))}

        <div
          data-testid="playhead"
          style={{
            position: 'absolute',
            left: pct(playheadMs),
            top: 0,
            bottom: 0,
            width: 2,
            background: '#fff',
            pointerEvents: 'none',
            boxShadow: '0 0 6px rgba(255,255,255,0.6)',
          }}
        />
      </div>

      {sel && (
        <div
          data-testid="segment-editor"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
            fontSize: 11,
          }}
        >
          <span style={{ opacity: 0.6 }}>
            {sel.kind === 'leg'
              ? `Leg ${sel.index + 1} → ${sel.index + 2}`
              : `Stop: ${stops[sel.index]?.name ?? ''}`}
          </span>
          <input
            data-testid="segment-duration"
            type="range"
            min={200}
            max={12000}
            step={100}
            value={selectedDuration}
            onChange={(e) => {
              const ms = Number(e.target.value);
              if (sel.kind === 'leg') onSetLegDuration(sel.index, ms);
              else onSetStopDwell(sel.index, ms);
            }}
            style={{ flex: 1 }}
          />
          <span
            data-testid="segment-duration-label"
            style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75, minWidth: 42 }}
          >
            {(selectedDuration / 1000).toFixed(1)}s
          </span>
          {isOverridden && (
            <button
              data-testid="clear-override"
              onClick={() =>
                sel.kind === 'leg'
                  ? onSetLegDuration(sel.index, null)
                  : onSetStopDwell(sel.index, null)
              }
              title="Back to the automatic duration"
              style={{
                background: 'transparent',
                border: '1px solid #2c3d5c',
                color: '#9fb0c8',
                borderRadius: 4,
                fontSize: 10,
                padding: '2px 7px',
                cursor: 'pointer',
              }}
            >
              auto
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Block({
  testid,
  left,
  width,
  top,
  height,
  color,
  active,
  label,
  onClick,
}: {
  testid: string;
  left: string;
  width: string;
  top: number;
  height: number;
  color: string;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={testid}
      data-active={active ? '1' : '0'}
      onMouseDown={(e) => {
        // Selecting a block shouldn't also scrub the playhead.
        e.stopPropagation();
        onClick();
      }}
      style={{
        position: 'absolute',
        left,
        width,
        top,
        height,
        background: color,
        border: active ? '2px solid #fff' : '1px solid rgba(0,0,0,0.35)',
        borderRadius: 4,
        color: '#fff',
        fontSize: 10,
        padding: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
      }}
      title={label}
    >
      {label}
    </button>
  );
}
