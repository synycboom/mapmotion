'use client';

import type { LegMode, TripStop } from '@mapmotion/engine';
import type { LegStatus } from '../lib/useLegRoutes';

export function StopList({
  stops,
  legModes,
  legStatuses,
  onRemove,
  onMove,
  onSetLegMode,
}: {
  stops: TripStop[];
  legModes: LegMode[];
  legStatuses: LegStatus[];
  onRemove: (i: number) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onSetLegMode: (leg: number, mode: LegMode) => void;
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

            {/* Connector between this stop and the next: how do we travel? */}
            {i < stops.length - 1 && (
              <LegConnector
                index={i}
                mode={legModes[i] ?? 'flight'}
                status={legStatuses[i] ?? 'idle'}
                onSet={onSetLegMode}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LegConnector({
  index,
  mode,
  status,
  onSet,
}: {
  index: number;
  mode: LegMode;
  status: LegStatus;
  onSet: (leg: number, mode: LegMode) => void;
}) {
  return (
    <div
      data-testid={`leg-${index}`}
      data-mode={mode}
      data-status={status}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 0 3px 18px',
        fontSize: 11,
      }}
    >
      <span style={{ opacity: 0.3 }}>│</span>
      <button
        onClick={() => onSet(index, 'flight')}
        aria-label={`Leg ${index + 1} as flight`}
        style={pill(mode === 'flight')}
      >
        ✈ Flight
      </button>
      <button
        onClick={() => onSet(index, 'drive')}
        aria-label={`Leg ${index + 1} as drive`}
        style={pill(mode === 'drive')}
      >
        🚗 Drive
      </button>
      {mode === 'track' && (
        <span style={pill(true)}>📍 Imported track</span>
      )}
      {mode === 'drive' && status === 'loading' && (
        <span style={{ opacity: 0.5 }}>finding roads…</span>
      )}
      {mode === 'drive' && status === 'fallback' && (
        <span
          title="No road route between these points — showing a direct line instead."
          style={{ color: '#ffc078' }}
        >
          no road route
        </span>
      )}
      {mode === 'track' && status === 'fallback' && (
        <span
          title="Track geometry isn't stored in the link. Re-import the file, or load the project from your library."
          style={{ color: '#ffc078' }}
        >
          track not in link — re-import
        </span>
      )}
    </div>
  );
}

function pill(active: boolean): React.CSSProperties {
  return {
    background: active ? '#e8590c' : 'transparent',
    color: active ? '#fff' : '#9fb0c8',
    border: `1px solid ${active ? '#e8590c' : '#2c3d5c'}`,
    borderRadius: 999,
    padding: '2px 9px',
    fontSize: 11,
    cursor: 'pointer',
    lineHeight: 1.5,
  };
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
