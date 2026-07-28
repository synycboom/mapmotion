'use client';

import type { TripStop } from '@mapmotion/engine';

export function StopList({
  stops,
  onRemove,
  onMove,
}: {
  stops: TripStop[];
  onRemove: (i: number) => void;
  onMove: (i: number, dir: -1 | 1) => void;
}) {
  if (stops.length === 0) {
    return (
      <p style={{ fontSize: 12, opacity: 0.5, margin: '10px 0' }}>
        No stops yet. Search above to add at least two.
      </p>
    );
  }

  return (
    <ol
      data-testid="stop-list"
      style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}
    >
      {stops.map((s, i) => (
        <li
          key={`${s.name}-${i}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            marginBottom: 4,
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
        </li>
      ))}
    </ol>
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
