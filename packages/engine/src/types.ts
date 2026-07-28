/**
 * Core scene model. The project document is a deterministic scene description:
 * the same JSON renders identically in live preview, in-browser export, and
 * (later) server-side 4K workers.
 *
 * Determinism rules:
 *  - No Date.now() / Math.random() anywhere in this package.
 *  - All time enters as tMs. All functions are pure.
 *  - Zero DOM / MapLibre imports — this package runs in Node for tests.
 */

export type LngLat = [number, number];

export interface CameraState {
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
}

export type EasingId =
  | 'linear'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInOutSine';

export interface ProjectFormat {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export interface CameraKeyframe {
  tMs: number;
  camera: CameraState;
  /** Easing applied on the segment ENDING at this keyframe. */
  easing?: EasingId;
}

export interface RouteTrack {
  id: string;
  /** Route geometry (precomputed, e.g. great-circle arc or road geometry). */
  coordinates: LngLat[];
  /** Draw-on animation window. */
  startMs: number;
  endMs: number;
  easing?: EasingId;
  color?: string;
  widthPx?: number;
}

export interface MarkerTrack {
  id: string;
  coordinate: LngLat;
  label?: string;
  /** When the marker pops in. */
  enterMs: number;
  enterDurationMs?: number;
  color?: string;
}

export interface Project {
  version: 1;
  name: string;
  format: ProjectFormat;
  camera: CameraKeyframe[];
  routes: RouteTrack[];
  markers: MarkerTrack[];
}

/** Fully-resolved state of the scene at one instant. */
export interface FrameState {
  camera: CameraState;
  /** Route id -> draw-on progress in [0, 1]. */
  routeProgress: Record<string, number>;
  /** Marker id -> enter-animation state. */
  markers: Record<string, { opacity: number; scale: number }>;
}
