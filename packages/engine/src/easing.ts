import type { EasingId } from './types';

export const easings: Record<EasingId, (t: number) => number> = {
  linear: (t) => t,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeInOutSine: (t) => (1 - Math.cos(Math.PI * t)) / 2,
};

export function ease(id: EasingId | undefined, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return easings[id ?? 'easeInOutCubic'](clamped);
}
