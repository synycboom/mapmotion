'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { needsRouting, travelMode, type LegMode, type LngLat, type TripStop } from '@mapmotion/engine';

export type LegStatus = 'idle' | 'loading' | 'ok' | 'fallback';

export interface LegMetrics {
  distanceMeters: number | null;
  durationSeconds: number | null;
}

export interface LegRoutes {
  /** Geometry per leg; null means "use an arc". */
  geometries: (LngLat[] | null)[];
  statuses: LegStatus[];
  /** Router-reported distance/duration per leg, where available. */
  metrics: (LegMetrics | null)[];
  loading: boolean;
}

const keyFor = (a: TripStop, b: TripStop) =>
  `${a.coordinate[0].toFixed(4)},${a.coordinate[1].toFixed(4)}` +
  `->${b.coordinate[0].toFixed(4)},${b.coordinate[1].toFixed(4)}`;

/**
 * Fetches road geometry for legs marked 'drive'.
 *
 * Cached by endpoint pair for the session, so toggling a leg back and forth
 * (or reordering stops) doesn't re-hit the router. Failures are cached as
 * `null` too — retrying a route that cannot exist (across an ocean) on every
 * render would just hammer the upstream.
 *
 * The returned arrays are memoized on a version counter rather than rebuilt
 * each render: they feed a useMemo that compiles the whole project, and a
 * fresh array reference every render would recompile (and reinstall map
 * layers) in a loop.
 */
export function useLegRoutes(stops: TripStop[], modes: LegMode[]): LegRoutes {
  const cache = useRef(new Map<string, LngLat[] | null>());
  const metrics = useRef(
    new Map<string, { distanceMeters: number | null; durationSeconds: number | null }>(),
  );
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);

  const legCount = Math.max(0, stops.length - 1);

  // A stable description of what we need, so the effect only re-runs when the
  // actual request set changes.
  const wanted = useMemo(() => {
    const out: Array<{ i: number; k: string; profile: string } | null> = [];
    for (let i = 0; i < legCount; i++) {
      const mode = modes[i];
      out.push(
        mode && needsRouting(mode)
          ? {
              i,
              k: `${travelMode(mode).profile}|${keyFor(stops[i]!, stops[i + 1]!)}`,
              profile: travelMode(mode).profile ?? 'car',
            }
          : null,
      );
    }
    return out;
  }, [stops, modes, legCount]);

  const wantedSig = wanted.map((w) => w?.k ?? '-').join('|');

  useEffect(() => {
    let cancelled = false;

    const missing = wanted.filter(
      (w): w is { i: number; k: string; profile: string } =>
        !!w && !cache.current.has(w.k),
    );
    if (missing.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void (async () => {
      await Promise.all(
        missing.map(async ({ i, k, profile }) => {
          const from = stops[i]!;
          const to = stops[i + 1]!;
          try {
            const qs = new URLSearchParams({
              from: `${from.coordinate[0]},${from.coordinate[1]}`,
              to: `${to.coordinate[0]},${to.coordinate[1]}`,
              profile,
            });
            const res = await fetch(`/api/route?${qs}`);
            const json = (await res.json()) as {
              geometry?: LngLat[] | null;
              distanceMeters?: number | null;
              durationSeconds?: number | null;
            };
            cache.current.set(k, json.geometry ?? null);
            metrics.current.set(k, {
              distanceMeters: json.distanceMeters ?? null,
              durationSeconds: json.durationSeconds ?? null,
            });
          } catch {
            cache.current.set(k, null);
          }
        }),
      );
      if (cancelled) return;
      setLoading(false);
      setVersion((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedSig]);

  return useMemo(() => {
    const geometries: (LngLat[] | null)[] = [];
    const statuses: LegStatus[] = [];
    const legMetrics: (LegMetrics | null)[] = [];
    for (const w of wanted) {
      if (!w) {
        geometries.push(null);
        statuses.push('idle');
        legMetrics.push(null);
      } else if (!cache.current.has(w.k)) {
        geometries.push(null);
        statuses.push('loading');
        legMetrics.push(null);
      } else {
        const g = cache.current.get(w.k)!;
        geometries.push(g);
        statuses.push(g ? 'ok' : 'fallback');
        legMetrics.push(metrics.current.get(w.k) ?? null);
      }
    }
    return { geometries, statuses, metrics: legMetrics, loading };
    // `version` is the signal that the cache contents changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedSig, version, loading]);
}
