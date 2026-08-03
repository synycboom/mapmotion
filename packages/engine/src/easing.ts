import type { EasingId } from './types';

/**
 * How fast a segment is still moving as it hands over to the next one,
 * relative to its own average speed. Zero is a dead stop.
 *
 * Every named easing below is an ease-IN-OUT, which by definition has zero
 * derivative at both ends. That is right for a single animation and wrong for
 * a chain of them: a fly-through built from ten such segments comes to a
 * complete halt ten times, and a cubic is flat enough near its endpoints to
 * hold the camera still for three or four frames at 30fps. A six-stop trip
 * spent a sixth of its running time not moving, which is what "the export
 * lags" turned out to mean.
 *
 * 0.55 keeps a clear sense of arrival — the camera still slows noticeably
 * into a stop — without ever reaching zero. Higher reads as a flat conveyor
 * belt; much lower and the pause creeps back in.
 */
export const GLIDE_V = 0.55;

/**
 * Cubic Hermite from 0 to 1 with prescribed endpoint velocities.
 *
 * One curve covers every case this codebase needs, which is why it replaces a
 * choice between named easings rather than joining them:
 *   glide(t, 0, 0) is exactly smoothstep — the old ease-in-out
 *   glide(t, 1, 1) is exactly linear
 *   glide(t, 0, v) eases away from rest and hands over still moving
 *
 * Velocities are in units of "fraction of the segment per unit of normalised
 * time", so 1 means the segment's own average speed. That normalisation is
 * what lets two adjacent segments of different length and duration be matched
 * by simply agreeing on a number.
 */
export function glide(t: number, v0: number, v1: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const t2 = clamped * clamped;
  const t3 = t2 * clamped;
  // Standard Hermite basis, with the h00 term dropped because p0 is 0 and the
  // h01 term simplified because p1 is 1.
  return (t3 - 2 * t2 + clamped) * v0 + (-2 * t3 + 3 * t2) + (t3 - t2) * v1;
}

export const easings: Record<EasingId, (t: number) => number> = {
  linear: (t) => t,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeInOutSine: (t) => (1 - Math.cos(Math.PI * t)) / 2,
  // The context-free reading of 'glide': moving at both ends. `cameraAt`
  // overrides this with the velocities the neighbouring segments imply, but
  // annotations, regions and titles call ease() with no neighbours to consult
  // and need an answer anyway.
  glide: (t) => glide(t, GLIDE_V, GLIDE_V),
};

export function ease(id: EasingId | undefined, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return easings[id ?? 'easeInOutCubic'](clamped);
}
