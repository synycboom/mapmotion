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

import type { AudioTrack } from './audio';
import type { RegionState, RegionTrack } from './regions';
import type { TitleCard, TitleState } from './title';
import type { TravelMode } from './travel';
import type { PinAppearance } from './pins';

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
  /**
   * van Wijk rho for the segment ENDING at this keyframe — how high the
   * camera arcs. Same "belongs to the incoming segment" convention as
   * `easing`, so a keyframe fully describes how you arrive at it.
   */
  rho?: number;
}

export interface VehicleConfig {
  /** Sprite id, e.g. 'plane' | 'car' | 'ship'. */
  icon: string;
  color: string;
  /** Sprite scale multiplier. */
  size?: number;
}

export interface RouteTrack {
  id: string;
  /** Route geometry (precomputed, e.g. great-circle arc or road geometry). */
  coordinates: LngLat[];
  /** How this leg is travelled — drives geometry, routing and vehicle. */
  mode?: TravelMode;
  /** Vehicle that rides along the path. Omit for no vehicle. */
  vehicle?: VehicleConfig;
  /** Metres, when a router supplied the geometry. */
  distanceMeters?: number;
  /** Seconds, when a router supplied the geometry. */
  durationSeconds?: number;
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
  /** Fully resolved appearance for this marker. */
  pin?: PinAppearance;
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
  /** Highlighted countries and groups. Geometry lives in the app. */
  regions?: RegionTrack[];
  /** Intro/outro text cards. */
  titles: TitleCard[];
  /**
   * Optional soundtrack. The decoded samples never live in the project —
   * they're megabytes and the project has to stay serialisable — so this
   * carries only the timing, the gain and the detected beats.
   */
  audio?: AudioTrack;
}

/** Fully-resolved state of the scene at one instant. */
export interface FrameState {
  camera: CameraState;
  /** Route id -> draw-on progress in [0, 1]. */
  routeProgress: Record<string, number>;
  /** Marker id -> enter-animation state. */
  markers: Record<string, { opacity: number; scale: number }>;
  /** Title cards visible at this instant, with their fade opacity. */
  titles: TitleState[];
  /** Region id -> entrance progress. */
  regions: Record<string, RegionState>;
  /**
   * Vehicle position and heading per route id, for routes that have one.
   * Absent while the leg is not in motion.
   */
  vehicles: Record<string, VehicleState>;
}

export interface VehicleState {
  coordinate: LngLat;
  /** Degrees clockwise from north — the sprite's icon-rotate. */
  bearing: number;
  icon: string;
  color: string;
  size: number;
  /** Fades in/out at the ends of the leg so it doesn't pop. */
  opacity: number;
}
