'use client';

import {
  ARC,
  BEARING_MODES,
  ZOOM_PRESETS,
  type BearingMode,
  type EasingId,
} from '@mapmotion/engine';
import { EASING_CHOICES, type CameraSettings } from '../lib/urlState';

/**
 * Camera controls: how close, how the move between stops is shaped, which way
 * the map faces, and how far it tilts.
 *
 * Grouped as one panel because these are all answers to the same question —
 * "what does the shot look like" — and because picking a framing usually
 * means immediately reaching for the arc and the tilt too.
 */
export function CameraPanel({
  camera,
  onChange,
  pitch,
  onPitchChange,
  disabled,
}: {
  camera: CameraSettings;
  onChange: (next: CameraSettings) => void;
  /** Tilt lives in the appearance state but belongs here in the UI. */
  pitch: number;
  onPitchChange: (deg: number) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof CameraSettings>(key: K, value: CameraSettings[K]) =>
    onChange({ ...camera, [key]: value });

  const isDefault =
    camera.zoomPreset === 'auto' &&
    Math.abs(camera.arc - ARC.default) < 1e-6 &&
    camera.bearingMode === 'fixed' &&
    camera.bearing === 0 &&
    camera.orbit === 0 &&
    camera.easing === 'easeInOutCubic' &&
    pitch === 0 &&
    !camera.stopZooms.some((z) => z !== null && z !== undefined);

  return (
    <div data-testid="camera-panel" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, opacity: 0.55, letterSpacing: 0.3 }}>Camera</span>
        <button
          data-testid="camera-reset"
          disabled={disabled || isDefault}
          title="Back to automatic framing"
          onClick={() => {
            onChange({
              zoomPreset: 'auto',
              arc: ARC.default,
              bearingMode: 'fixed',
              bearing: 0,
              orbit: 0,
              easing: 'easeInOutCubic',
              stopZooms: [],
            });
            onPitchChange(0);
          }}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid #2c3d5c',
            color: '#9fb0c8',
            borderRadius: 4,
            fontSize: 10,
            padding: '2px 7px',
            cursor: isDefault ? 'default' : 'pointer',
            opacity: isDefault ? 0.35 : 1,
          }}
        >
          Reset
        </button>
      </div>

      {/* ---- framing ---- */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ZOOM_PRESETS.map((p) => {
          const on = camera.zoomPreset === p.id;
          return (
            <button
              key={p.id}
              data-testid={`zoom-${p.id}`}
              data-on={on ? '1' : '0'}
              disabled={disabled}
              title={p.hint}
              onClick={() => set('zoomPreset', p.id)}
              style={pill(on)}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 10, opacity: 0.4, margin: '5px 0 0' }}>
        {camera.zoomPreset === 'auto'
          ? 'Each stop is framed by its nearest neighbour, so short hops stay close.'
          : ZOOM_PRESETS.find((p) => p.id === camera.zoomPreset)?.hint}
      </p>

      {/* ---- arc ---- */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 5 }}>
          Travel arc · {camera.arc.toFixed(2)}
          <span style={{ opacity: 0.6, marginLeft: 6 }}>
            {camera.arc < 1.2 ? 'direct' : camera.arc > 2 ? 'sweeping' : 'natural'}
          </span>
        </div>
        <input
          data-testid="arc-slider"
          type="range"
          min={ARC.min}
          max={ARC.max}
          step={0.02}
          value={camera.arc}
          disabled={disabled}
          onChange={(e) => set('arc', Number(e.target.value))}
          style={{ width: '100%' }}
        />
        <p style={{ fontSize: 10, opacity: 0.4, margin: '2px 0 0' }}>
          How far the camera pulls back on the way between two stops.
        </p>
      </div>

      {/* ---- tilt ---- */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 5 }}>
          Tilt · {Math.round(pitch)}°
        </div>
        <input
          data-testid="pitch-slider"
          type="range"
          min={0}
          max={75}
          step={1}
          value={pitch}
          disabled={disabled}
          onChange={(e) => onPitchChange(Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </div>

      {/* ---- rotation ---- */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 5 }}>Rotation</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {BEARING_MODES.map((m) => {
            const on = camera.bearingMode === m.id;
            return (
              <button
                key={m.id}
                data-testid={`bearing-mode-${m.id}`}
                data-on={on ? '1' : '0'}
                disabled={disabled}
                title={m.hint}
                onClick={() => set('bearingMode', m.id as BearingMode)}
                style={{
                  flex: 1,
                  background: on ? '#e8590c' : '#1c2a42',
                  border: `1px solid ${on ? '#e8590c' : '#34496b'}`,
                  color: '#e6edf5',
                  borderRadius: 6,
                  padding: '6px 4px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 10, opacity: 0.5, minWidth: 62 }}>
            {camera.bearingMode === 'travel' ? 'Offset' : 'Heading'} {Math.round(camera.bearing)}°
          </span>
          <input
            data-testid="bearing-slider"
            type="range"
            min={0}
            max={359}
            step={1}
            value={camera.bearing}
            disabled={disabled}
            onChange={(e) => set('bearing', Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {/* ---- orbit ---- */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 5 }}>
          Orbit at each stop · {camera.orbit > 0 ? '+' : ''}
          {Math.round(camera.orbit)}°
        </div>
        <input
          data-testid="orbit-slider"
          type="range"
          min={-180}
          max={180}
          step={5}
          value={camera.orbit}
          disabled={disabled}
          onChange={(e) => set('orbit', Number(e.target.value))}
          style={{ width: '100%' }}
        />
        <p style={{ fontSize: 10, opacity: 0.4, margin: '2px 0 0' }}>
          The map turns this far while the camera is parked. Pairs well with tilt.
        </p>
      </div>

      {/* ---- easing ---- */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 5 }}>Movement</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {EASING_CHOICES.map((e) => {
            const on = camera.easing === e.id;
            return (
              <button
                key={e.id}
                data-testid={`easing-${e.id}`}
                data-on={on ? '1' : '0'}
                disabled={disabled}
                onClick={() => set('easing', e.id as EasingId)}
                style={pill(on)}
              >
                {e.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function pill(on: boolean): React.CSSProperties {
  return {
    background: on ? '#e8590c' : '#1c2a42',
    color: '#e6edf5',
    border: `1px solid ${on ? '#e8590c' : '#34496b'}`,
    borderRadius: 999,
    padding: '4px 9px',
    fontSize: 11,
    cursor: 'pointer',
  };
}
