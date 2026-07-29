import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Layout breakpoint. Below this the editor stacks: preview on top, controls
 * underneath. 900px rather than a phone width because the two-column layout
 * needs ~340px of controls plus a preview wide enough to be worth looking at,
 * and a portrait tablet has neither.
 */
export const NARROW_PX = 900;

/**
 * True when the viewport is too narrow for the side-by-side layout.
 *
 * Starts `false` on the server and on the first client render so markup
 * matches and React doesn't complain about a hydration mismatch; the real
 * value lands in the effect immediately after.
 */
export function useNarrow(maxWidth = NARROW_PX): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    // Safari only grew addEventListener on MediaQueryList in 14; the app
    // supports older iOS than that in principle, so fall back.
    if (mq.addEventListener) {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, [maxWidth]);
  return narrow;
}

/** Smallest preview scale we'll ever apply. Never zero, never negative. */
const MIN_SCALE = 0.05;

/**
 * Fit a fixed-size preview into whatever space its container actually has.
 *
 * The previous implementation derived the available width from
 * `window.innerWidth - 400`, hard-coding the sidebar. On a phone that
 * subtraction goes negative, which produced `transform: scale(-0.008)` — the
 * map rendered correctly into its WebGL canvas (so exports were fine) but was
 * mirrored down to nothing on screen. Measuring the container removes the
 * assumption entirely, and the clamp makes a wrong measurement produce a small
 * preview rather than an invisible one.
 */
export function usePreviewFit(
  ref: RefObject<HTMLElement | null>,
  outWidth: number,
  outHeight: number,
  /** Fraction of the viewport height the preview may occupy. */
  heightFraction: number,
  /** Vertical space reserved for transport controls and chrome. */
  reservedPx: number,
): number {
  const [scale, setScale] = useState(0.5);
  // Keep the latest inputs in a ref so the observer doesn't need re-creating
  // on every format change — re-creating it drops a measurement on iOS.
  const sizeRef = useRef({ outWidth, outHeight, heightFraction, reservedPx });
  sizeRef.current = { outWidth, outHeight, heightFraction, reservedPx };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      const s = sizeRef.current;
      const availW = el.clientWidth || window.innerWidth;
      // visualViewport tracks the space actually visible on iOS as the URL
      // bar collapses; innerHeight lags behind it and over-reports.
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const availH = Math.max(120, vh * s.heightFraction - s.reservedPx);
      const next = Math.min(availW / s.outWidth, availH / s.outHeight, 1);
      setScale(Number.isFinite(next) ? Math.max(MIN_SCALE, next) : MIN_SCALE);
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [ref, outWidth, outHeight, heightFraction, reservedPx]);

  return scale;
}
