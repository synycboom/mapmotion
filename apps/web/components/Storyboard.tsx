'use client';

import type { PinAppearance, TripStop } from '@mapmotion/engine';

/**
 * The trip as a horizontal strip of stops with the travel legs between them.
 *
 * Two jobs. It shows the shape of the video at a glance — how many stops,
 * how long each is, where the time actually goes — which a vertical list in a
 * sidebar never did. And it is the fastest way to select a stop, because
 * clicking the place you can see beats scrolling to find its row.
 *
 * Deliberately not the Studio timeline: that one is to-scale and for
 * retiming. This is to-order and for navigating.
 */
export function Storyboard({
  stops,
  dwells,
  legs,
  thumbnails,
  selected,
  playheadMs,
  onSelect,
  onSeek,
}: {
  stops: TripStop[];
  /** Compiled dwell per stop, ms. */
  dwells: number[];
  /** Compiled travel time per leg, ms. */
  legs: number[];
  /** Per-stop marker overrides, so photo imports show their photograph. */
  thumbnails: (Partial<PinAppearance> | null)[];
  selected: { kind: 'leg' | 'stop'; index: number } | null;
  playheadMs: number;
  onSelect: (sel: { kind: 'leg' | 'stop'; index: number } | null) => void;
  /** Jump the preview to the start of a segment. */
  onSeek: (ms: number) => void;
}) {
  if (stops.length === 0) return null;

  /** Start time of stop i, from the same segment list the compiler produced. */
  const startOf = (index: number) => {
    let t = 0;
    for (let i = 0; i < index; i++) t += (dwells[i] ?? 0) + (legs[i] ?? 0);
    return t;
  };

  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  return (
    <div
      data-testid="storyboard"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        marginTop: 12,
        padding: '8px 2px',
        overflowX: 'auto',
      }}
    >
      {stops.map((stop, i) => {
        const dwell = dwells[i] ?? 0;
        const start = startOf(i);
        const isCurrent = playheadMs >= start && playheadMs < start + dwell;
        const on = selected?.kind === 'stop' && selected.index === i;
        const image = thumbnails[i]?.imageUrl;
        return (
          <div key={`${stop.name}-${i}`} style={{ display: 'flex', alignItems: 'stretch' }}>
            <button
              data-testid={`board-stop-${i}`}
              data-on={on ? '1' : '0'}
              onClick={() => {
                onSelect({ kind: 'stop', index: i });
                onSeek(start + Math.min(120, dwell / 2));
              }}
              title={`${stop.name} · ${secs(dwell)}`}
              style={{
                width: 92,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                padding: '7px 6px',
                background: on ? '#1c2a42' : '#101a2c',
                border: `1px solid ${on ? '#e8590c' : isCurrent ? '#34496b' : '#1c2a42'}`,
                borderRadius: 8,
                color: '#e6edf5',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                  flexShrink: 0,
                  background: image ? `center/cover url(${image})` : '#e8590c',
                  // A photo pin gets a ring so it reads the same on the strip
                  // as it does on the map.
                  boxShadow: image ? 'inset 0 0 0 2px #fff' : undefined,
                  color: image ? 'transparent' : '#fff',
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  fontSize: 10,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {stop.name}
              </span>
              <span style={{ fontSize: 9, opacity: 0.5 }}>{secs(dwell)}</span>
            </button>

            {i < stops.length - 1 && (
              <button
                data-testid={`board-leg-${i}`}
                data-on={selected?.kind === 'leg' && selected.index === i ? '1' : '0'}
                onClick={() => {
                  onSelect({ kind: 'leg', index: i });
                  onSeek(startOf(i) + dwell + 40);
                }}
                title={`Travel to ${stops[i + 1]?.name} · ${secs(legs[i] ?? 0)}`}
                style={{
                  alignSelf: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 1,
                  padding: '2px 6px',
                  margin: '0 2px',
                  background: 'transparent',
                  border: 'none',
                  color:
                    selected?.kind === 'leg' && selected.index === i ? '#e8590c' : '#5f7391',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 12, lineHeight: 1 }}>→</span>
                <span style={{ fontSize: 9, opacity: 0.55 }}>{secs(legs[i] ?? 0)}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
