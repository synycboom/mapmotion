'use client';

import { useState } from 'react';
import { TRAVEL_MODES, travelMode, type LegMode } from '@mapmotion/engine';
import type { LegMetrics, LegStatus } from '../lib/useLegRoutes';

/**
 * The travel-mode control that sits between two stops.
 *
 * Nine modes is too many for a pill row, so the common three (flight, car,
 * walk) stay one click away and the rest live behind a "more" popover. That
 * keeps Quick mode uncluttered while still exposing the full set — the same
 * simple-by-default principle as the Quick/Studio split.
 */
const QUICK_MODES: LegMode[] = ['air', 'car', 'walk'];

export function LegConnector({
  index,
  mode,
  status,
  metrics,
  onSet,
}: {
  index: number;
  mode: LegMode;
  status: LegStatus;
  metrics: LegMetrics | null;
  onSet: (leg: number, mode: LegMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const spec = travelMode(mode);
  const isQuick = QUICK_MODES.includes(mode);

  return (
    <div
      data-testid={`leg-${index}`}
      data-mode={mode}
      data-status={status}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 0 3px 18px',
        fontSize: 11,
        position: 'relative',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ opacity: 0.3 }}>│</span>

      {QUICK_MODES.map((m) => {
        const s = travelMode(m);
        return (
          <button
            key={m}
            onClick={() => onSet(index, m)}
            aria-label={`Leg ${index + 1} as ${s.label}`}
            title={s.hint}
            style={pill(mode === m)}
          >
            {s.glyph} {s.label}
          </button>
        );
      })}

      <button
        data-testid={`leg-${index}-more`}
        onClick={() => setOpen((v) => !v)}
        aria-label={`More travel modes for leg ${index + 1}`}
        style={pill(!isQuick)}
      >
        {isQuick ? '···' : `${spec.glyph} ${spec.label}`}
      </button>

      {open && (
        <div
          data-testid={`leg-${index}-menu`}
          style={{
            position: 'absolute',
            zIndex: 40,
            top: '100%',
            left: 18,
            marginTop: 3,
            background: '#0f1a2b',
            border: '1px solid #34496b',
            borderRadius: 6,
            padding: 4,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 2,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            minWidth: 210,
          }}
        >
          {TRAVEL_MODES.filter((m) => m.id !== 'file').map((m) => (
            <button
              key={m.id}
              data-testid={`leg-${index}-mode-${m.id}`}
              onClick={() => {
                onSet(index, m.id);
                setOpen(false);
              }}
              title={m.hint}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: mode === m.id ? '#1c2a42' : 'transparent',
                border: 'none',
                color: '#e6edf5',
                borderRadius: 4,
                padding: '5px 8px',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ width: 14 }}>{m.glyph}</span>
              {m.label}
            </button>
          ))}
        </div>
      )}

      {mode === 'file' && <span style={pill(true)}>📍 Imported track</span>}

      {status === 'loading' && <span style={{ opacity: 0.5 }}>finding route…</span>}
      {status === 'fallback' && mode !== 'file' && (
        <span
          title="No road route between these points — showing a direct line instead."
          style={{ color: '#ffc078' }}
        >
          no road route
        </span>
      )}
      {status === 'fallback' && mode === 'file' && (
        <span
          title="Track geometry isn't stored in the link. Re-import the file, or load the project from your library."
          style={{ color: '#ffc078' }}
        >
          track not in link — re-import
        </span>
      )}

      {status === 'ok' && metrics?.distanceMeters != null && (
        <span data-testid={`leg-${index}-metrics`} style={{ opacity: 0.55 }}>
          {formatDistance(metrics.distanceMeters)}
          {metrics.durationSeconds != null && ` · ${formatDuration(metrics.durationSeconds)}`}
        </span>
      )}
    </div>
  );
}

export function formatDistance(metres: number): string {
  const km = metres / 1000;
  if (km < 1) return `${Math.round(metres)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours} h ${rem} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
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
    whiteSpace: 'nowrap',
  };
}
