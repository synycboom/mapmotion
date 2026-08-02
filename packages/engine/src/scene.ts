import type {
  CameraState,
  FrameState,
  Project,
  VehicleState,
} from './types';
import { ease } from './easing';
import { flyInterpolate } from './camera';
import { titlesAt } from './title';
import { cumulativeDistances, pointAtProgress } from './geo';

/**
 * Evaluate the full scene at time tMs. Pure function — the single source of
 * truth for preview, in-browser export, and server-side render workers.
 */
export function sceneAt(project: Project, tMs: number): FrameState {
  const routeProgress: Record<string, number> = {};
  const vehicles: Record<string, VehicleState> = {};

  for (const r of project.routes) {
    const local = (tMs - r.startMs) / Math.max(1, r.endMs - r.startMs);
    const progress = ease(r.easing ?? 'easeInOutSine', local);
    routeProgress[r.id] = progress;

    if (r.vehicle && r.coordinates.length >= 2) {
      const at = pointAtProgress(
        r.coordinates,
        cumulativeFor(project, r.id, r.coordinates),
        progress,
      );
      if (at) {
        vehicles[r.id] = {
          coordinate: at.coordinate,
          bearing: at.bearing,
          icon: r.vehicle.icon,
          color: r.vehicle.color,
          size: r.vehicle.size ?? 1,
          // Fade in as the leg starts and out as it ends, so the vehicle
          // doesn't pop into existence or sit parked at the destination.
          opacity: vehicleOpacity(local),
        };
      }
    }
  }

  const regions: Record<string, { progress: number }> = {};
  for (const r of project.regions ?? []) {
    const local = (tMs - r.enterMs) / Math.max(1, r.enterDurationMs);
    regions[r.id] = { progress: ease(r.easing ?? 'easeOutCubic', local) };
  }

  return {
    camera: cameraAt(project, tMs),
    routeProgress,
    titles: titlesAt(project.titles ?? [], tMs),
    regions,
    vehicles,
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

/** Visible only while the leg is in motion, with short fades at each end. */
function vehicleOpacity(local: number): number {
  if (local <= 0 || local >= 1) return 0;
  const FADE = 0.08; // fraction of the leg
  if (local < FADE) return local / FADE;
  if (local > 1 - FADE) return (1 - local) / FADE;
  return 1;
}

/**
 * Cumulative distances are pure derived data, but recomputing them for every
 * frame of every route is wasteful on long imported tracks. Cache per
 * project object — the cache is keyed by identity, so a recompiled project
 * gets a fresh one automatically and stale geometry can never be used.
 */
const cumulativeCache = new WeakMap<Project, Map<string, number[]>>();

function cumulativeFor(
  project: Project,
  routeId: string,
  coords: readonly [number, number][],
): number[] {
  let perProject = cumulativeCache.get(project);
  if (!perProject) {
    perProject = new Map();
    cumulativeCache.set(project, perProject);
  }
  let cum = perProject.get(routeId);
  if (!cum) {
    cum = cumulativeDistances(coords as [number, number][]);
    perProject.set(routeId, cum);
  }
  return cum;
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
    rho: k1.rho,
  });
}
