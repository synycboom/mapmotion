import type { CameraState, FrameState, Project } from './types';
import { ease } from './easing';
import { flyInterpolate } from './camera';

/**
 * Evaluate the full scene at time tMs. Pure function — the single source of
 * truth for preview, in-browser export, and server-side render workers.
 */
export function sceneAt(project: Project, tMs: number): FrameState {
  return {
    camera: cameraAt(project, tMs),
    routeProgress: Object.fromEntries(
      project.routes.map((r) => {
        const local = (tMs - r.startMs) / Math.max(1, r.endMs - r.startMs);
        return [r.id, ease(r.easing ?? 'easeInOutSine', local)];
      }),
    ),
    markers: Object.fromEntries(
      project.markers.map((m) => {
        const dur = m.enterDurationMs ?? 400;
        const local = (tMs - m.enterMs) / Math.max(1, dur);
        const k = ease('easeOutCubic', local);
        // Pop: overshoot scale slightly then settle.
        const scale = local <= 0 ? 0 : local >= 1 ? 1 : k * 1.15 - 0.15 * k * k;
        return [m.id, { opacity: k, scale }];
      }),
    ),
  };
}

export function cameraAt(project: Project, tMs: number): CameraState {
  const kfs = project.camera;
  if (kfs.length === 0) {
    return { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 };
  }
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (tMs <= first.tMs) return { ...first.camera, center: [...first.camera.center] };
  if (tMs >= last.tMs) return { ...last.camera, center: [...last.camera.center] };

  let i = 1;
  while (i < kfs.length && kfs[i]!.tMs < tMs) i++;
  const k0 = kfs[i - 1]!;
  const k1 = kfs[i]!;
  const local = (tMs - k0.tMs) / Math.max(1, k1.tMs - k0.tMs);
  const eased = ease(k1.easing, local);
  return flyInterpolate(k0.camera, k1.camera, eased, {
    size: [project.format.width, project.format.height],
  });
}
