import type { LngLat } from './types';

/**
 * Ramer–Douglas–Peucker line simplification.
 *
 * Road geometry from a routing API routinely runs to thousands of points for
 * a single leg. At animation zoom levels almost none of that detail is
 * visible, but it inflates the project document and slows every frame's
 * line-slicing. Simplifying up front keeps the shape while cutting the point
 * count by an order of magnitude.
 *
 * Tolerance is in degrees, applied in planar lng/lat space — fine for the
 * scales we animate at, and cheap.
 */
export function simplifyLine(points: readonly LngLat[], tolerance = 0.0015): LngLat[] {
  if (points.length <= 2) return points.map((p) => [...p] as LngLat);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative rather than recursive: a long route can exceed the call stack.
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;

  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let index = -1;

    for (let i = start + 1; i < end; i++) {
      const d = perpDistSq(points[i]!, points[start]!, points[end]!);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }

    if (maxDist > tol2 && index !== -1) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  const out: LngLat[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push([...points[i]!] as LngLat);
  }
  return out;
}

/** Squared perpendicular distance from p to segment a-b. */
function perpDistSq(p: LngLat, a: LngLat, b: LngLat): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}
