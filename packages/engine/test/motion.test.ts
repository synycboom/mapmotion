import { describe, expect, it } from 'vitest';
import {
  compileTrip,
  DEFAULT_ORBIT_DEG,
  distanceMeters,
  ease,
  glide,
  sceneAt,
  type Project,
  type TripStop,
} from '../src';

/**
 * Does the camera actually keep moving?
 *
 * Every other camera test asks where the camera IS at a given moment. None of
 * them asked how far it travels BETWEEN two consecutive frames, and that is
 * the number a viewer perceives: a fly-through that covers the right ground
 * but does it in ten lurches reads as a broken export, not as a stylistic
 * choice.
 *
 * The failure this suite was written for: every segment used an ease-in-out
 * curve, which by definition has zero derivative at both ends. Adjacent
 * segments therefore met at a dead stop — the leg decelerated to nothing, the
 * dwell accelerated from nothing — and at 30fps a cubic is flat enough near
 * its endpoints to hold the camera still for three or four frames. With a
 * stop every second or so, the whole video stuttered.
 */

const PARIS_WALK: TripStop[] = [
  { name: 'La Defense', coordinate: [2.238, 48.8925] },
  { name: 'Arc de Triomphe', coordinate: [2.295, 48.8738] },
  { name: 'Louvre', coordinate: [2.3376, 48.8606] },
  { name: 'Bastille', coordinate: [2.3692, 48.8532] },
  { name: 'Pere Lachaise', coordinate: [2.3934, 48.8614] },
  { name: 'Vincennes', coordinate: [2.435, 48.8447] },
];

const CONTINENTAL: TripStop[] = [
  { name: 'Lisbon', coordinate: [-9.1393, 38.7223] },
  { name: 'Paris', coordinate: [2.3522, 48.8566] },
  { name: 'Prague', coordinate: [14.4378, 50.0755] },
  { name: 'Athens', coordinate: [23.7275, 37.9838] },
];

/**
 * A project compiled the way the app compiles one.
 *
 * `zoomPreset: 'auto'` matters more than it looks. Without it compileTrip
 * falls back to a fixed zoom of 5.2, at which a six-stop walk across Paris is
 * a handful of pixels wide and almost all the measured movement comes from
 * the bearing term — so the suite would be grading the orbit and barely
 * looking at the pan. The app always passes 'auto'; so does this.
 */
function trip(stops: TripStop[], over: Record<string, unknown> = {}): Project {
  return compileTrip('T', stops, {
    format: { width: 1280, height: 720, fps: 30 },
    zoomPreset: 'auto',
    dwellMs: 600,
    legMs: 1300,
    orbitDeg: DEFAULT_ORBIT_DEG,
    ...over,
  });
}

/** Web mercator: the world is 512px at zoom 0. */
const EQUATOR_M_PER_PX = 40075016.686 / 512;

function metresPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/**
 * How much the view changes between two frames, measured in SCREEN pixels.
 *
 * Metres were the obvious first choice and they are badly wrong. A fly-through
 * zooms out to cross a continent, so a frame in the middle of a long leg
 * covers hundreds of kilometres while a frame at either end covers a few
 * hundred metres — and judged in metres the ends look frozen even when the
 * map is sliding past at a perfectly even rate. That is precisely the illusion
 * van Wijk's interpolation exists to create, and a test that penalises it
 * would be a test against the feature.
 *
 * Pan, zoom and rotation are then commensurable, because all three are
 * expressed as how far a point on screen moved. The reference radius for
 * rotation and the pixels-per-zoom-level are perceptual weights, not physics;
 * they only have to be consistent.
 */
function motionScores(project: Project): number[] {
  const { fps, durationMs } = project.format;
  const frames = Math.round((durationMs / 1000) * fps);
  const scores: number[] = [];
  let prev = sceneAt(project, 0).camera;
  for (let i = 1; i < frames; i++) {
    const cur = sceneAt(project, (i / fps) * 1000).camera;
    const midLat = (prev.center[1] + cur.center[1]) / 2;
    const midZoom = (prev.zoom + cur.zoom) / 2;
    const panPx = distanceMeters(prev.center, cur.center) / metresPerPixel(midLat, midZoom);
    const zoomPx = Math.abs(cur.zoom - prev.zoom) * 400;
    const REFERENCE_RADIUS_PX = 300;
    const bearingPx =
      (Math.abs(cur.bearing - prev.bearing) * Math.PI * REFERENCE_RADIUS_PX) / 180;
    scores.push(panPx + zoomPx + bearingPx);
    prev = cur;
  }
  return scores;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

/**
 * Split frames into the ones during a travel leg and the ones during a dwell.
 *
 * The two have different obligations. A leg must never stall — the camera is
 * supposed to be going somewhere. A dwell with no orbit is *entitled* to be
 * perfectly still, because that is what the user asked for, and a test that
 * banned it would be demanding motion nobody wants.
 */
function byPhase(project: Project, scores: number[]) {
  const { fps } = project.format;
  const legs = project.routes.map((r) => [r.startMs, r.endMs] as const);
  const inLeg: number[] = [];
  const inDwell: number[] = [];
  // Only the animated body. The held frames past the last keyframe are in no
  // leg, so a naive split files them under "dwell" — which made the dwell
  // bucket contain the deliberate end freeze and every question about dwell
  // motion unanswerable.
  for (const { index, score } of animatedFrames(project, scores)) {
    // A score covers the interval between two frames. Keyframes land on
    // fractional frame numbers, so some intervals contain part of a leg AND
    // part of a dwell — frame 127 of the reference trip straddles a boundary
    // at 126.7. Those belong to neither bucket, and forcing them into one is
    // how a perfectly static dwell came to report 0.77 pixels of movement.
    const fromMs = ((index - 1) / fps) * 1000;
    const toMs = (index / fps) * 1000;
    const whollyInLeg = legs.some(([a, b]) => fromMs >= a && toMs <= b);
    const whollyOutside = legs.every(([a, b]) => toMs <= a || fromMs >= b);
    if (whollyInLeg) inLeg.push(score);
    else if (whollyOutside) inDwell.push(score);
  }
  return { inLeg, inDwell };
}

/**
 * Frames that are supposed to be animating at all.
 *
 * `compileTrip` deliberately runs the video 400ms past its last camera
 * keyframe so it ends on a held shot rather than cutting on the move. Those
 * trailing frames are identical by design, and counting them as a stall would
 * make every one of these tests fail on a feature.
 */
function animatedFrames(project: Project, scores: number[]): { index: number; score: number }[] {
  const { fps } = project.format;
  const lastKeyframeMs = project.camera[project.camera.length - 1]!.tMs;
  // Also trim a few frames at each edge of the animated range. The video is
  // supposed to ease away from rest and back down into it; 'starts and ends
  // at rest' asserts exactly that, and counting those same frames as stalls
  // here would make the two tests contradict each other.
  const EDGE = 4;
  return scores
    .map((score, idx) => ({ index: idx + 1, score }))
    .filter(({ index }) => (index / fps) * 1000 <= lastKeyframeMs)
    .slice(EDGE, -EDGE);
}

/**
 * Movement below which the render cannot change.
 *
 * An absolute floor in screen pixels, not a fraction of the clip's own
 * median. Fractions cannot compare two configurations — a video that is
 * uniformly slow scores well against its own median while looking frozen, and
 * that is exactly how the before/after comparison below would have been
 * fooled into calling the old behaviour better.
 */
const FROZEN_PX = 0.5;

/** Is this frame inside a travel leg — with slack for the settle at each end? */
function insideDwell(project: Project, frameIndex: number, slackFrames = 3): boolean {
  const { fps } = project.format;
  const tMs = (frameIndex / fps) * 1000;
  const slackMs = (slackFrames / fps) * 1000;
  return !project.routes.some((r) => tMs > r.startMs + slackMs && tMs < r.endMs - slackMs);
}

describe('camera keeps moving', () => {
  it('never freezes mid-video when the dwells orbit', () => {
    for (const stops of [PARIS_WALK, CONTINENTAL]) {
      const project = trip(stops);
      const frozen = animatedFrames(project, motionScores(project)).filter(
        (f) => f.score < FROZEN_PX,
      );
      expect(frozen.map((f) => f.index), `${stops.length} stops`).toEqual([]);
    }
  });

  it('never crawls during a leg', () => {
    // Scoped to legs on purpose. An earlier version of this measured crawling
    // across the whole video and reported 36% — which turned out to be
    // exactly the fraction of the running time spent on dwells. It was
    // grading the existence of the dwell, not the quality of the motion.
    const project = trip(PARIS_WALK);
    const scores = motionScores(project);
    const { inLeg } = byPhase(project, scores);
    const med = median(inLeg);
    const crawling = inLeg.filter((s) => s < med * 0.2);
    expect(crawling.length / inLeg.length).toBeLessThan(0.08);
  });

  it('legs never stall, at any orbit', () => {
    // The obligation that holds unconditionally. A dwell may be still — with
    // orbitDeg 0 that is exactly what was asked for — but a leg is the camera
    // going somewhere, and it must not stop on the way.
    for (const stops of [PARIS_WALK, CONTINENTAL]) {
      for (const orbitDeg of [0, 12, 25, 60]) {
        const project = trip(stops, { orbitDeg });
        const stalled = animatedFrames(project, motionScores(project)).filter(
          (f) => f.score < FROZEN_PX && !insideDwell(project, f.index),
        );
        expect(stalled.map((f) => f.index), `orbit ${orbitDeg}, ${stops.length} stops`).toEqual(
          [],
        );
      }
    }
  });

  it('still lets a dwell be perfectly still when no orbit was asked for', () => {
    // The other half of the contract. Removing the stutter must not smear
    // motion across a pause the user deliberately requested.
    const project = trip(PARIS_WALK, { orbitDeg: 0 });
    const { inDwell } = byPhase(project, motionScores(project));
    expect(Math.max(...inDwell)).toBeLessThan(0.01);
  });

  it('keeps the default dwell moving, which is what stops the freeze', () => {
    const project = trip(PARIS_WALK);
    const { inDwell } = byPhase(project, motionScores(project));
    expect(Math.min(...inDwell)).toBeGreaterThan(FROZEN_PX);
  });

  it('starts and ends at rest', () => {
    const scores = motionScores(trip(PARIS_WALK));
    const med = median(scores);
    expect(scores[0]!).toBeLessThan(med);
    expect(scores[scores.length - 1]!).toBeLessThan(med);
  });

  it('has no single frame that jumps far beyond its neighbours', () => {
    // The opposite fault, and the one a naive "just make it linear" fix
    // introduces: a velocity discontinuity at a keyframe shows up as one
    // frame of outsized travel, which reads as a glitch rather than a
    // stutter. Trading a stall for a jolt would not be a fix.
    for (const stops of [PARIS_WALK, CONTINENTAL]) {
      const project = trip(stops);
      const scores = motionScores(project);
      const med = median(scores);
      for (let i = 1; i < scores.length - 1; i++) {
        const neighbours = (scores[i - 1]! + scores[i + 1]!) / 2;
        expect(scores[i]!, `frame ${i + 1} of ${stops.length}-stop trip`).toBeLessThan(
          Math.max(neighbours * 4, med * 6),
        );
      }
    }
  });

  it('is a large improvement on the defaults it replaced', () => {
    // Guards the fix itself rather than the symptom. Both halves matter: the
    // easing removed the dead stop at each junction, and the dwell orbit
    // removed the dead stop through each pause. Reverting either one should
    // fail here with a count, not a vague threshold breach.
    const stalls = (p: Project) =>
      animatedFrames(p, motionScores(p)).filter((f) => f.score < FROZEN_PX).length;

    const fixed = trip(PARIS_WALK);
    const oldDefaults = trip(PARIS_WALK, { orbitDeg: 0, travelEasing: 'easeInOutCubic' });
    const total = animatedFrames(oldDefaults, motionScores(oldDefaults)).length;

    expect(stalls(fixed)).toBe(0);
    // The old defaults froze for well over a third of the video.
    expect(stalls(oldDefaults)).toBeGreaterThan(total * 0.3);
  });
});

describe('glide', () => {
  // One-sided at the ends on purpose: `glide` clamps its input, so a central
  // difference straddling t=0 averages the real slope with a flat zero and
  // reports exactly half the truth.
  const derivative = (v0: number, v1: number, t: number, h = 1e-6) => {
    if (t <= 0) return (glide(h, v0, v1) - glide(0, v0, v1)) / h;
    if (t >= 1) return (glide(1, v0, v1) - glide(1 - h, v0, v1)) / h;
    return (glide(t + h, v0, v1) - glide(t - h, v0, v1)) / (2 * h);
  };

  it('starts at 0 and ends at 1 whatever the velocities', () => {
    for (const [v0, v1] of [[0, 0], [0.55, 0.55], [1, 1], [0, 1], [1, 0], [2, 2]]) {
      expect(glide(0, v0!, v1!)).toBeCloseTo(0, 12);
      expect(glide(1, v0!, v1!)).toBeCloseTo(1, 12);
    }
  });

  it('honours the endpoint velocities it was given', () => {
    expect(derivative(0.55, 0.3, 0)).toBeCloseTo(0.55, 4);
    expect(derivative(0.55, 0.3, 1)).toBeCloseTo(0.3, 4);
    expect(derivative(0, 0, 0)).toBeCloseTo(0, 4);
  });

  it('degenerates to the two curves it generalises', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      // v=1 at both ends is exactly linear.
      expect(glide(t, 1, 1)).toBeCloseTo(t, 12);
      // v=0 at both ends is exactly smoothstep.
      expect(glide(t, 0, 0)).toBeCloseTo(3 * t * t - 2 * t * t * t, 12);
    }
  });

  it('is monotonic at the velocities the compiler actually uses', () => {
    // A Hermite with large endpoint tangents can overshoot and come back,
    // which would show up as the camera briefly reversing at a stop.
    for (const [v0, v1] of [[0, 0.55], [0.55, 0], [0.55, 0.55]]) {
      let prev = -1;
      for (let i = 0; i <= 200; i++) {
        const v = glide(i / 200, v0!, v1!);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('never leaves 0..1 at those velocities', () => {
    for (const [v0, v1] of [[0, 0.55], [0.55, 0], [0.55, 0.55]]) {
      for (let i = 0; i <= 200; i++) {
        const v = glide(i / 200, v0!, v1!);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('clamps out-of-range time like every other easing', () => {
    expect(glide(-5, 0.55, 0.55)).toBe(0);
    expect(glide(5, 0.55, 0.55)).toBe(1);
    expect(ease('glide', -1)).toBe(0);
    expect(ease('glide', 2)).toBe(1);
  });

  it('is reachable through ease() for callers without keyframe context', () => {
    // Annotations, regions and titles all go through ease(id, t) with no
    // neighbours to consult. 'glide' has to mean something sensible there.
    expect(ease('glide', 0.5)).toBeCloseTo(0.5, 6);
    expect(ease('glide', 0)).toBe(0);
    expect(ease('glide', 1)).toBe(1);
  });
});
