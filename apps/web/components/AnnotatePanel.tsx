'use client';

import { useRef } from 'react';
import {
  ANNOTATION_KINDS,
  DEFAULT_ANNOTATION,
  annotationSpec,
  type AnnotationKind,
  type LngLat,
} from '@mapmotion/engine';
import { thumbnail } from '../lib/photoImport';

/** An annotation as the editor holds it, before compiling. */
export interface AnnotationSetting {
  kind: AnnotationKind;
  coordinates: LngLat[];
  color: string;
  text: string;
  imageUrl: string;
  fontSize: number;
  sizePx: number;
  widthPx: number;
  fillOpacity: number;
  dashed: boolean;
  /** Fraction of the video at which it appears / starts leaving. */
  enterAt: number;
  exitAt: number | null;
}

const SWATCHES = ['#e8590c', '#ffffff', '#1971c2', '#2f9e44', '#f08c00', '#e03131'];

export function newAnnotation(kind: AnnotationKind): AnnotationSetting {
  return {
    kind,
    coordinates: [],
    color: kind === 'text' ? '#ffffff' : DEFAULT_ANNOTATION.color,
    text: kind === 'text' ? 'Label' : '',
    imageUrl: '',
    fontSize: DEFAULT_ANNOTATION.fontSize,
    sizePx: DEFAULT_ANNOTATION.sizePx,
    widthPx: DEFAULT_ANNOTATION.widthPx,
    fillOpacity: DEFAULT_ANNOTATION.fillOpacity,
    dashed: false,
    enterAt: 0,
    exitAt: null,
  };
}

export function AnnotatePanel({
  annotations,
  onChange,
  placing,
  onStartPlacing,
  onCancelPlacing,
  selected,
  onSelect,
  disabled,
}: {
  annotations: AnnotationSetting[];
  onChange: (next: AnnotationSetting[]) => void;
  /** Index currently awaiting clicks on the map, or null. */
  placing: number | null;
  onStartPlacing: (kind: AnnotationKind) => void;
  onCancelPlacing: () => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const imageTargetRef = useRef<number | null>(null);

  const update = (i: number, patch: Partial<AnnotationSetting>) =>
    onChange(annotations.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const pickImage = async (file: File | undefined) => {
    const i = imageTargetRef.current;
    if (!file || i === null) return;
    // Same downscale path as photo pins: a 4MB JPEG as a map sprite is a
    // waste of memory and MapLibre's atlas has limits.
    const url = await thumbnail(file, 256);
    if (url) update(i, { imageUrl: url });
  };

  return (
    <div data-testid="annotate-panel">
      <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 6 }}>Add to the map</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ANNOTATION_KINDS.map((k) => (
          <button
            key={k.id}
            data-testid={`annotate-add-${k.id}`}
            onClick={() => onStartPlacing(k.id)}
            title={k.hint}
            disabled={disabled}
            style={pill}
          >
            <span style={{ marginRight: 4 }}>{k.glyph}</span>
            {k.label}
          </button>
        ))}
      </div>

      {placing !== null && (
        <div
          data-testid="annotate-placing"
          style={{
            marginTop: 9,
            padding: '7px 9px',
            background: 'rgba(232,89,12,0.12)',
            border: '1px solid #e8590c',
            borderRadius: 7,
            fontSize: 11,
          }}
        >
          {annotations[placing] &&
          (annotationSpec(annotations[placing]!.kind)?.points ?? 1) >
            annotations[placing]!.coordinates.length
            ? `Click the map${
                (annotationSpec(annotations[placing]!.kind)?.points ?? 1) === 2 &&
                annotations[placing]!.coordinates.length === 0
                  ? ' twice'
                  : ''
              } to place it`
            : 'Placed'}
          <button
            data-testid="annotate-cancel"
            onClick={onCancelPlacing}
            style={{ ...pill, marginLeft: 8, padding: '2px 8px', fontSize: 10 }}
          >
            Cancel
          </button>
        </div>
      )}

      {annotations.length === 0 && placing === null && (
        <p style={{ fontSize: 10, opacity: 0.4, margin: '8px 0 0' }}>
          Text, arrows and shapes pinned to real coordinates — they move with
          the map and fade in when you choose.
        </p>
      )}

      <input
        ref={fileRef}
        data-testid="annotate-image-input"
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => void pickImage(e.target.files?.[0])}
      />

      {annotations.map((a, i) => {
        const spec = annotationSpec(a.kind);
        const open = selected === i;
        return (
          <div
            key={i}
            data-testid={`annotate-item-${i}`}
            style={{
              marginTop: 10,
              padding: 9,
              background: '#101a2c',
              border: `1px solid ${open ? '#34496b' : '#24334d'}`,
              borderRadius: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
              <span>{spec?.glyph}</span>
              <button
                data-testid={`annotate-select-${i}`}
                onClick={() => onSelect(open ? null : i)}
                style={{
                  flex: 1,
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  color: '#e6edf5',
                  fontSize: 12,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {a.kind === 'text' ? a.text || 'Text' : spec?.label}
              </button>
              <button
                data-testid={`annotate-remove-${i}`}
                onClick={() => {
                  onChange(annotations.filter((_, j) => j !== i));
                  onSelect(null);
                }}
                aria-label="Remove"
                style={iconBtn}
              >
                ✕
              </button>
            </div>

            {open && (
              <div data-testid={`annotate-editor-${i}`}>
                {a.kind === 'text' && (
                  <input
                    data-testid={`annotate-${i}-text`}
                    value={a.text}
                    onChange={(e) => update(i, { text: e.target.value })}
                    placeholder="Label text"
                    style={{ ...inputStyle, marginTop: 7 }}
                  />
                )}

                {a.kind === 'image' && (
                  <button
                    data-testid={`annotate-${i}-choose-image`}
                    onClick={() => {
                      imageTargetRef.current = i;
                      fileRef.current?.click();
                    }}
                    style={{ ...pill, marginTop: 7, width: '100%' }}
                  >
                    {a.imageUrl ? 'Replace image' : 'Choose an image'}
                  </button>
                )}

                <div style={{ display: 'flex', gap: 4, marginTop: 7 }}>
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      data-testid={`annotate-${i}-colour-${c.slice(1)}`}
                      onClick={() => update(i, { color: c })}
                      aria-label={`Colour ${c}`}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 4,
                        background: c,
                        border: `2px solid ${a.color === c ? '#e6edf5' : 'transparent'}`,
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  ))}
                </div>

                {a.kind === 'text' && (
                  <Slider
                    testId={`annotate-${i}-size`}
                    label={`Text size · ${Math.round(a.fontSize)}`}
                    min={10}
                    max={64}
                    step={1}
                    value={a.fontSize}
                    onChange={(v) => update(i, { fontSize: v })}
                  />
                )}
                {a.kind === 'image' && (
                  <Slider
                    testId={`annotate-${i}-size`}
                    label={`Size · ${Math.round(a.sizePx)}px`}
                    min={24}
                    max={320}
                    step={4}
                    value={a.sizePx}
                    onChange={(v) => update(i, { sizePx: v })}
                  />
                )}
                {a.kind !== 'text' && a.kind !== 'image' && (
                  <>
                    <Slider
                      testId={`annotate-${i}-width`}
                      label={`Stroke · ${a.widthPx.toFixed(0)}px`}
                      min={1}
                      max={12}
                      step={1}
                      value={a.widthPx}
                      onChange={(v) => update(i, { widthPx: v })}
                    />
                    {(a.kind === 'rect' || a.kind === 'circle') && (
                      <Slider
                        testId={`annotate-${i}-fill`}
                        label={`Fill · ${Math.round(a.fillOpacity * 100)}%`}
                        min={0}
                        max={1}
                        step={0.05}
                        value={a.fillOpacity}
                        onChange={(v) => update(i, { fillOpacity: v })}
                      />
                    )}
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        marginTop: 7,
                        opacity: 0.8,
                      }}
                    >
                      <input
                        data-testid={`annotate-${i}-dashed`}
                        type="checkbox"
                        checked={a.dashed}
                        onChange={(e) => update(i, { dashed: e.target.checked })}
                      />
                      Dashed
                    </label>
                  </>
                )}

                <Slider
                  testId={`annotate-${i}-enter`}
                  label={
                    a.enterAt === 0 ? 'Appears · from the start' : `Appears · ${Math.round(a.enterAt * 100)}% in`
                  }
                  min={0}
                  max={1}
                  step={0.05}
                  value={a.enterAt}
                  onChange={(v) => update(i, { enterAt: v })}
                />
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    marginTop: 7,
                    opacity: 0.8,
                  }}
                >
                  <input
                    data-testid={`annotate-${i}-fades`}
                    type="checkbox"
                    checked={a.exitAt !== null}
                    onChange={(e) =>
                      update(i, { exitAt: e.target.checked ? Math.min(0.9, a.enterAt + 0.3) : null })
                    }
                  />
                  Fades out again
                </label>
                {a.exitAt !== null && (
                  <Slider
                    testId={`annotate-${i}-exit`}
                    label={`Leaves · ${Math.round(a.exitAt * 100)}% in`}
                    min={0}
                    max={1}
                    step={0.05}
                    value={a.exitAt}
                    onChange={(v) => update(i, { exitAt: v })}
                  />
                )}

                <button
                  data-testid={`annotate-${i}-replace`}
                  onClick={() => onStartPlacing(a.kind)}
                  style={{ ...pill, marginTop: 8, width: '100%' }}
                >
                  Place another
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Slider({
  testId,
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  testId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 2 }}>{label}</div>
      <input
        data-testid={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}

const pill: React.CSSProperties = {
  background: '#1c2a42',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 999,
  padding: '4px 9px',
  fontSize: 11,
  cursor: 'pointer',
};

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #2c3d5c',
  color: '#ff8787',
  borderRadius: 4,
  fontSize: 11,
  padding: '1px 6px',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111c2e',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 6,
  padding: '6px 9px',
  fontSize: 12,
  boxSizing: 'border-box',
};
