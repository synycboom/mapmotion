'use client';

import { LABEL_CATEGORIES, type LabelCategory } from '../lib/mapAppearance';
import type { MapAppearance } from '../lib/urlState';

/**
 * Basemap appearance: which labels show, projection, tilt and terrain.
 *
 * Grouped as one panel because these decisions are made together — you pick
 * a look, not five unrelated settings. Mapimator's style popover uses the
 * same grouping (View / Labels / Map type) and it reads well.
 */
export function AppearancePanel({
  appearance,
  onChange,
  layerCounts,
  disabled,
}: {
  appearance: MapAppearance;
  onChange: (next: MapAppearance) => void;
  /** How many style layers each category controls; 0 means nothing to toggle. */
  layerCounts: Record<LabelCategory, number>;
  disabled?: boolean;
}) {
  const set = <K extends keyof MapAppearance>(key: K, value: MapAppearance[K]) =>
    onChange({ ...appearance, [key]: value });

  const allOn = LABEL_CATEGORIES.every(({ id }) => appearance.labels[id]);
  const anyOn = LABEL_CATEGORIES.some(({ id }) => appearance.labels[id]);

  return (
    <div data-testid="appearance-panel" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, opacity: 0.55, letterSpacing: 0.3 }}>Labels</span>
        <button
          data-testid="labels-toggle-all"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...appearance,
              labels: {
                places: !allOn,
                countries: !allOn,
                roads: !allOn,
                water: !allOn,
                pois: !allOn,
              },
            })
          }
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid #2c3d5c',
            color: '#9fb0c8',
            borderRadius: 4,
            fontSize: 10,
            padding: '2px 7px',
            cursor: 'pointer',
          }}
        >
          {anyOn ? 'None' : 'All'}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {LABEL_CATEGORIES.map(({ id, label }) => {
          const on = appearance.labels[id];
          const none = layerCounts[id] === 0;
          return (
            <button
              key={id}
              data-testid={`label-${id}`}
              data-on={on ? '1' : '0'}
              disabled={disabled || none}
              title={
                none
                  ? 'This basemap has no layers in that category'
                  : `${on ? 'Hide' : 'Show'} ${label.toLowerCase()}`
              }
              onClick={() =>
                onChange({
                  ...appearance,
                  labels: { ...appearance.labels, [id]: !on },
                })
              }
              style={{
                background: on ? '#1c2a42' : 'transparent',
                color: on ? '#e6edf5' : '#66799a',
                border: `1px solid ${on ? '#34496b' : '#22314c'}`,
                borderRadius: 999,
                padding: '3px 9px',
                fontSize: 11,
                cursor: none ? 'default' : 'pointer',
                opacity: none ? 0.35 : 1,
                textDecoration: on ? 'none' : 'line-through',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 14 }}>
        <span style={{ fontSize: 11, opacity: 0.55, letterSpacing: 0.3 }}>View</span>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {(['mercator', 'globe'] as const).map((p) => (
            <button
              key={p}
              data-testid={`projection-${p}`}
              disabled={disabled}
              onClick={() => set('projection', p)}
              style={{
                flex: 1,
                background: appearance.projection === p ? '#e8590c' : '#1c2a42',
                border: `1px solid ${appearance.projection === p ? '#e8590c' : '#34496b'}`,
                color: '#e6edf5',
                borderRadius: 6,
                padding: '6px 4px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {p === 'mercator' ? 'Flat' : '🌐 Globe'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 5 }}>
          Tilt · {Math.round(appearance.pitch)}°
        </div>
        <input
          data-testid="pitch-slider"
          type="range"
          min={0}
          max={75}
          step={1}
          value={appearance.pitch}
          disabled={disabled}
          onChange={(e) => set('pitch', Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          marginTop: 10,
          opacity: appearance.pitch > 0 ? 0.85 : 0.55,
        }}
      >
        <input
          data-testid="terrain-toggle"
          type="checkbox"
          checked={appearance.terrain}
          disabled={disabled}
          onChange={(e) => set('terrain', e.target.checked)}
        />
        3D terrain
        <span style={{ opacity: 0.5, fontSize: 10 }}>
          {appearance.pitch === 0 ? '· tilt to see it' : ''}
        </span>
      </label>
    </div>
  );
}
