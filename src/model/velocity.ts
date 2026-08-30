/**
 * Velocity ramps — a clip's speed as a curve over its own footage.
 *
 * A ramp is a keyframe list like any other (`ease` and `bezier` included, so
 * the graph editor and the keyframe selection work on it unchanged), with two
 * deliberate differences from `ClipAnimation`:
 *
 * - `t` is SOURCE ms measured from `sourceInMs`, not clip-local timeline ms.
 *   Timeline ms would be circular: the ramp decides the clip's duration, so a
 *   key placed in timeline time would move every time the curve it belongs to
 *   changes. Source time is also the right mental model — a ramp is authored on
 *   a moment of the footage ("the board hits the rail"), and it stays welded to
 *   that frame when the rest of the curve is reshaped. Splits and trims then
 *   reduce to `sliceChannel` / `shiftChannel` over the source window.
 * - `value` is RELATIVE to `clip.speed`: 1 = whatever the clip's base speed is.
 *   So the scalar speed control keeps its exact meaning, and pressing 2× on a
 *   ramped clip scales the whole ramp instead of destroying it.
 *
 * The rate the renderer wants is source-ms per timeline-ms. Going the other way
 * — timeline time to source time, which is what every read site actually asks
 * for — means inverting `T(s) = ∫₀ˢ ds'/r(s')`. `r` is strictly positive, so `T`
 * is strictly increasing and invertible; it is built once per curve as a
 * cumulative table and inverted by binary search.
 */

import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from '../app/config';
import type { Clip, Keyframe } from '../types';
import { sampleChannel, shiftChannel, sliceChannel } from './animation';

/** A clip carrying a ramp: `velocity` present and holding at least one key. */
export type RampedClip = Clip & { velocity: Keyframe[] };

/** Whether a clip's speed varies over its length rather than being a constant. */
export function hasVelocity(clip: Clip): clip is RampedClip {
  return Array.isArray(clip.velocity) && clip.velocity.length > 0;
}

/**
 * Effective playback rate at a source offset: source ms consumed per timeline
 * ms. Clamped to the same bounds the scalar speed obeys, so a ramp can never
 * reach a rate the decoder and the trim handles would refuse.
 */
export function rateAt(clip: RampedClip, sourceOffsetMs: number): number {
  const rate = clip.speed * sampleChannel(clip.velocity, sourceOffsetMs);
  return Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, rate));
}

/**
 * Cumulative timeline time over a clip's source span, sampled at a fixed source
 * step. `cum[i]` is the timeline ms elapsed once `i * step` ms of source have
 * been consumed; it is strictly increasing because the rate is strictly
 * positive.
 */
export interface VelocityMap {
  /** Source ms the clip's window spans (`sourceOutMs - sourceInMs`). */
  sourceSpanMs: number;
  /** Timeline ms the whole window takes at this ramp — the unlocked duration. */
  spanMs: number;
  /** Source ms between consecutive samples. */
  step: number;
  cum: Float64Array;
}

/**
 * Source resolution the integral is sampled at. 2 ms is an eighth of a frame at
 * 60 fps: fine enough that the accumulated drift over a long clip stays well
 * under a frame, coarse enough that a ten-minute clip still fits the cap below.
 */
const TARGET_STEP_MS = 2;
/** Sample ceiling, so a long clip trades resolution for a bounded table. */
const MAX_SAMPLES = 8192;
/** Sample floor, so a very short ramp is still integrated on a real curve. */
const MIN_SAMPLES = 64;

/**
 * One-entry cache per curve. Keyed on the keyframe array's identity, which the
 * store's copy-on-write edits already give us: an untouched ramp keeps its
 * array reference across every unrelated project mutation, and a touched one
 * gets a fresh array and so a fresh table. The signature guards the rest of the
 * inputs (the source window and the base speed), which live on the clip and can
 * change without the curve changing.
 */
const cache = new WeakMap<Keyframe[], { sig: string; map: VelocityMap }>();

function signature(clip: RampedClip): string {
  return `${clip.sourceInMs}|${clip.sourceOutMs}|${clip.speed}`;
}

/** The cumulative table for a clip's ramp, built on first use and cached. */
export function velocityMap(clip: RampedClip): VelocityMap {
  const sig = signature(clip);
  const hit = cache.get(clip.velocity);
  if (hit && hit.sig === sig) return hit.map;

  const sourceSpanMs = Math.max(0, clip.sourceOutMs - clip.sourceInMs);
  const samples = Math.min(
    MAX_SAMPLES,
    Math.max(MIN_SAMPLES, Math.ceil(sourceSpanMs / TARGET_STEP_MS)),
  );
  const step = sourceSpanMs / samples;
  const cum = new Float64Array(samples + 1);
  // Trapezoid over 1/rate: the integrand is smooth between keys, and the step
  // is far below the scale on which an eased segment bends.
  let prev = 1 / rateAt(clip, 0);
  for (let i = 1; i <= samples; i++) {
    const inv = 1 / rateAt(clip, i * step);
    cum[i] = cum[i - 1]! + ((prev + inv) / 2) * step;
    prev = inv;
  }

  const map: VelocityMap = { sourceSpanMs, spanMs: cum[samples]!, step, cum };
  cache.set(clip.velocity, { sig, map });
  return map;
}

/** Timeline ms elapsed at a source offset — the forward direction, no search. */
export function timelineAtSourceOffset(clip: RampedClip, sourceOffsetMs: number): number {
  const map = velocityMap(clip);
  if (map.step <= 0) return 0;
  const x = Math.min(map.sourceSpanMs, Math.max(0, sourceOffsetMs)) / map.step;
  const i = Math.min(map.cum.length - 2, Math.floor(x));
  const frac = x - i;
  return map.cum[i]! + (map.cum[i + 1]! - map.cum[i]!) * frac;
}

/**
 * Source offset reached after `localMs` of timeline — the inverse, by binary
 * search over the cumulative table. Clamped at both ends: past the end of the
 * window a locked clip holds its last frame rather than reading past the source.
 */
export function sourceOffsetAtTimeline(clip: RampedClip, localMs: number): number {
  const map = velocityMap(clip);
  if (localMs <= 0 || map.spanMs <= 0) return 0;
  if (localMs >= map.spanMs) return map.sourceSpanMs;
  const cum = map.cum;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= localMs) lo = mid;
    else hi = mid;
  }
  const span = cum[hi]! - cum[lo]!;
  const frac = span <= 0 ? 0 : (localMs - cum[lo]!) / span;
  return (lo + frac) * map.step;
}

/**
 * Timeline duration of a ramped clip.
 *
 * Unlocked (the default) the duration is elastic: the whole source window plays
 * whatever the ramp does to it, so the clip stretches and the plan is never
 * truncated. Locked, the duration is frozen at what the clip would last with no
 * ramp at all — the Vegas behaviour. What the ramp then fails to reach is
 * reported by `unreachedSourceMs`, and what it overruns by `frozenTailMs`, so
 * neither loss goes unsaid.
 */
export function rampDurationMs(clip: RampedClip): number {
  if (clip.velocityLocked) return (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
  return velocityMap(clip).spanMs;
}

/**
 * Source ms a locked ramp never reaches, 0 when it consumes the window whole.
 *
 * This has NO extent on the timeline, which is the whole subtlety of the lock:
 * every second of the clip still plays something, just more slowly, and the end
 * of the shot is simply never arrived at. So it is reported as a quantity for
 * the inspector to state in words, not as a region for the timeline to shade -
 * shading part of the clip would claim those seconds show nothing, and they do.
 */
export function unreachedSourceMs(clip: RampedClip): number {
  if (!clip.velocityLocked) return 0;
  const map = velocityMap(clip);
  const reached = sourceOffsetAtTimeline(clip, rampDurationMs(clip));
  return Math.max(0, map.sourceSpanMs - reached);
}

/**
 * Timeline ms at the END of a locked clip where the source has run out and the
 * last frame is held.
 *
 * The mirror of `unreachedSourceMs`, and the case that DOES have an extent: a
 * ramp that speeds the footage up consumes the window before the frozen
 * duration is over, and everything after that is one still frame. Always 0
 * without the lock, where the clip's length is the ramp's own by construction.
 */
export function frozenTailMs(clip: RampedClip): number {
  if (!clip.velocityLocked) return 0;
  const map = velocityMap(clip);
  return Math.max(0, rampDurationMs(clip) - map.spanMs);
}

/** Lowest and highest rate the ramp actually reaches, for the inspector's readout. */
export function rampRange(clip: RampedClip): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const span = Math.max(0, clip.sourceOutMs - clip.sourceInMs);
  // The extremes of an eased segment sit at its ends, so the keys plus the two
  // window edges cover them — no need to walk the sampled table.
  const probes = [0, span, ...clip.velocity.map((k) => k.t)];
  for (const t of probes) {
    if (t < 0 || t > span) continue;
    const r = rateAt(clip, t);
    if (r < min) min = r;
    if (r > max) max = r;
  }
  return { min: min === Infinity ? clip.speed : min, max: max === -Infinity ? clip.speed : max };
}

/**
 * A ramp restricted to a source sub-window and rebased on it — what a split or
 * a trim owes the curve. Delegates to the animation razor, which already
 * synthesizes the boundary keys so neither side of a cut changes speed at the
 * seam. Returns undefined when nothing is left to animate, which is how a
 * sliced-away ramp collapses back to the plain scalar speed.
 */
export function sliceVelocity(
  velocity: Keyframe[],
  startOffsetMs: number,
  endOffsetMs: number,
): Keyframe[] | undefined {
  const sliced = sliceChannel(velocity, startOffsetMs, endOffsetMs);
  return Array.isArray(sliced) ? sliced : undefined;
}

/**
 * A ramp shifted because the clip's `sourceInMs` moved (a left trim). Keys are
 * anchored to the source, so they move the opposite way to the window's head.
 */
export function shiftVelocity(velocity: Keyframe[], sourceInDeltaMs: number): Keyframe[] {
  const shifted = shiftChannel(velocity, -sourceInDeltaMs);
  return Array.isArray(shifted) ? shifted : velocity;
}

/**
 * The ramp presets, named for what you see rather than for the shape of the
 * curve. Values are multipliers of the clip's base speed, times are fractions
 * of the source window, so one preset fits a clip of any length.
 *
 * `slow` is 0.25 across the board: it is the deepest ramp that still reads as
 * motion once the frames are blended, and going deeper is what the numeric
 * field is for.
 */
export type RampPresetId = 'slowDown' | 'speedUp' | 'highlight' | 'whip';

interface PresetPoint {
  /** Position in the source window, 0..1. */
  at: number;
  value: number;
  ease?: Keyframe['ease'];
}

export const RAMP_PRESETS: Record<RampPresetId, PresetPoint[]> = {
  // Enters at speed, settles into slow motion and stays there.
  slowDown: [
    { at: 0, value: 1 },
    { at: 0.55, value: 0.25 },
  ],
  // Starts slow, picks the pace back up — the tail of a highlight.
  speedUp: [
    { at: 0.45, value: 0.25 },
    { at: 1, value: 1 },
  ],
  // The classic speed ramp: in, hold the beat, out.
  highlight: [
    { at: 0, value: 1 },
    { at: 0.35, value: 0.25 },
    { at: 0.65, value: 0.25 },
    { at: 1, value: 1 },
  ],
  // Accelerates, then breaks hard into slow motion. `hold` on the last key of
  // the run-up is wrong here — the drop has to be a fall, not a step.
  whip: [
    { at: 0, value: 1 },
    { at: 0.4, value: 2.5, ease: 'in' },
    { at: 0.5, value: 0.3, ease: 'out' },
    { at: 1, value: 1 },
  ],
};

/** A preset's keyframes, laid onto a source window of `sourceSpanMs`. */
export function rampPresetKeys(preset: RampPresetId, sourceSpanMs: number): Keyframe[] {
  return RAMP_PRESETS[preset].map((p) => {
    const key: Keyframe = { t: p.at * sourceSpanMs, value: p.value };
    if (p.ease) key.ease = p.ease;
    return key;
  });
}
