'use client';

import { MAX_ZOOM, MIN_ZOOM, type LegMode, type TripStop } from '@mapmotion/engine';
import type { LegMetrics, LegStatus } from '../lib/useLegRoutes';
import { LegConnector } from './LegConnector';

export function StopList({
  stops,
  legModes,
  legStatuses,
  legMetrics,
  stopZooms,
  autoZooms,
  onRemove,
  onMove,
  onSetLegMode,
  onSetStopZoom,
}: {
  stops: TripStop[];
  legModes: LegMode[];
  legStatuses: LegStatus[];
  legMetrics: (LegMetrics | null)[];
  /** Per-stop zoom override; `null` means "use the project framing". */
  stopZooms: (number | null)[];
  /** What the project framing would pick, shown as the placeholder value. */
  autoZooms: number[];
  onRemove: (i: number) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onSetLegMode: (leg: number, mode: LegMode) => void;
  onSetStopZoom: (i: number, zoom: number | null) => void;
}) {
  if (stops.length === 0) {
    return (
      <p style={{ fontSize: 12, opacity: 0.5, margin: '10px 0' }}>
        No stops yet. Search above to add at least two.
      </p>
    );
  }

  return (
    <div data-testid="stop-list-wrap" style={{ marginTop: 10 }}>
      <ol data-testid="stop-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {stops.map((s, i) => (
          <li key={`${s.name}-${i}`}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                background: '#111c2e',
                border: '1px solid #24334d',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '50%',
                  background: '#e8590c',
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.name}
              </span>
              <button
                onClick={() => onMove(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${s.name} up`}
                style={iconBtn(i === 0)}
              >
                ↑
              </button>
              <button
                onClick={() => onMove(i, 1)}
                disabled={i === stops.length - 1}
                aria-label={`Move ${s.name} down`}
                style={iconBtn(i === stops.length - 1)}
              >
                ↓
              </button>
              <button
                onClick={() => onRemove(i)}
                aria-label={`Remove ${s.name}`}
                style={{ ...iconBtn(false), color: '#ff8787' }}
              >
                ✕
              </button>
            </div>

            <StopZoom
              index={i}
              name={s.name}
              value={stopZooms[i] ?? null}
              auto={autoZooms[i] ?? 5}
              onSet={onSetStopZoom}
            />

            {/* Connector between this stop and the next: how do we travel? */}
            {i < stops.length - 1 && (
              <LegConnector
                index={i}
                mode={legModes[i] ?? 'air'}
                status={legStatuses[i] ?? 'idle'}
                metrics={legMetrics[i] ?? null}
                onSet={onSetLegMode}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Per-stop zoom override.
 *
 * Collapsed to a single line showing the value the project framing would pick,
 * so the common case (leave it alone) costs no attention, and overriding one
 * stop doesn't mean switching the whole trip to a fixed zoom.
 */
function StopZoom({
  index,
  name,
  value,
  auto,
  onSet,
}: {
  index: number;
  name: string;
  value: number | null;
  auto: number;
  onSet: (i: number, zoom: number | null) => void;
}) {
  const overridden = value !== null && value !== undefined;
  const shown = overridden ? value : auto;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px 5px',
        fontSize: 10,
        opacity: overridden ? 0.95 : 0.45,
      }}
    >
      <span style={{ minWidth: 54 }}>
        zoom {shown.toFixed(1)}
        {overridden ? '' : ' · auto'}
      </span>
      <input
        data-testid={`stop-zoom-${index}`}
        aria-label={`Zoom at ${name}`}
        type="range"
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.1}
        value={shown}
        onChange={(e) => onSet(index, Number(e.target.value))}
        style={{ flex: 1, height: 14 }}
      />
      <button
        data-testid={`stop-zoom-reset-${index}`}
        onClick={() => onSet(index, null)}
        disabled={!overridden}
        title="Back to automatic framing for this stop"
        style={{
          background: 'transparent',
          border: '1px solid #2c3d5c',
          color: '#9fb0c8',
          borderRadius: 4,
          fontSize: 9,
          padding: '1px 5px',
          cursor: overridden ? 'pointer' : 'default',
          opacity: overridden ? 1 : 0.3,
        }}
      >
        auto
      </button>
    </div>
  );
}

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    color: '#e6edf5',
    border: '1px solid #2c3d5c',
    borderRadius: 4,
    width: 22,
    height: 22,
    fontSize: 11,
    lineHeight: 1,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.25 : 0.8,
    flexShrink: 0,
    padding: 0,
  };
}
