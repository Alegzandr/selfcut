/**
 * Animatable channels — the spine of the keyframe system.
 *
 * A property that can animate (position, scale, rotation, opacity, volume, any
 * effect parameter) is stored as a `Channel`: either a constant number, or a
 * list of keyframes sampled over the clip's local time. Preview and export both
 * sample through `sampleChannel`, so an animation renders identically in the
 * monitor and in the exported file — the same "one code path" property that
 * fades, crossfades and Ken Burns zoom already rely on.
 *
 * Keyframe time is CLIP-LOCAL timeline ms: `t = 0` is the clip's start on the
 * timeline, measured in the same post-speed timeline milliseconds as
 * `clipEnvelopeGainAt`'s `local`. Callers sample with
 * `sampleChannel(channel, timelineMs - clip.timelineStartMs)`. Keyframes moving
 * with the clip (relative to its start) is the behaviour a monteur expects when
 * they slide a clip along the timeline.
 *
 * Pure data and pure functions: a channel is plain JSON, so undo snapshots,
 * autosave and persistence carry it for free.
 */

import type { Channel, EaseId, Keyframe } from '../types';

export type { Channel, EaseId, Keyframe } from '../types';

/** The flow-first default easing: nothing snaps unless the user asks it to. */
export const DEFAULT_EASE: EaseId = 'inOut';

/**
 * Every named easing at runtime, in picker order (smooth curves first, the
 * stepping `hold` last). Doubles as the guard an imported file is checked
 * against, so the pickers and the parser can never disagree on what exists.
 */
export const EASE_IDS: readonly EaseId[] = ['linear', 'in', 'out', 'inOut', 'hold'];

/** Whether a channel actually animates (has keyframes) rather than being constant. */
export function isAnimated(channel: Channel): channel is Keyframe[] {
  return Array.isArray(channel) && channel.length > 0;
}

/** Named easing presets, expressed as the cubic-Bézier a custom curve would use. */
const EASE_BEZIER: Record<'in' | 'out' | 'inOut', [number, number, number, number]> = {
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  inOut: [0.42, 0, 0.58, 1],
};

/**
 * Cubic-Bézier easing `y` for a progress `x` in [0,1], with implicit endpoints
 * (0,0) and (1,1) — the same curve CSS `cubic-bezier()` and the AE/Premiere
 * value graph draw. Solves `x = bezierX(t)` by Newton-Raphson, then returns
 * `bezierY(t)`. A handful of iterations is plenty for sub-pixel accuracy.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-6) break;
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  return sampleY(Math.max(0, Math.min(1, t)));
}

/** Eased progress in [0,1] for a linear progress `p`, per a keyframe's easing. */
function easeProgress(key: Keyframe, p: number): number {
  if (key.bezier) return cubicBezier(key.bezier[0], key.bezier[1], key.bezier[2], key.bezier[3], p);
  const ease = key.ease ?? DEFAULT_EASE;
  if (ease === 'linear') return p;
  if (ease === 'hold') return 0; // the value stays at this key until the next one
  const b = EASE_BEZIER[ease];
  return cubicBezier(b[0], b[1], b[2], b[3], p);
}

/**
 * The cubic-Bezier a graph editor should draw and edit for a key: its custom
 * curve when it has one, otherwise the control points of its named preset.
 * `null` for `hold` and `linear`, which are not curves - a graph editor shows
 * them as a step and a straight line, with no handles to grab.
 */
export function keyBezier(key: Keyframe): [number, number, number, number] | null {
  if (key.bezier) return key.bezier;
  const ease = key.ease ?? DEFAULT_EASE;
  return ease === 'hold' || ease === 'linear' ? null : [...EASE_BEZIER[ease]];
}

/**
 * Eased progress in [0,1] (overshoot allowed) for a key's curve — the same math
 * `sampleChannel` interpolates with, exposed so the graph editor plots exactly
 * the curve the renderer will follow.
 */
export function easeAt(key: Keyframe, p: number): number {
  return easeProgress(key, p);
}

/**
 * How a keyframe should be drawn on the timeline, from the easing of the
 * segment it governs. Every NLE spells interpolation as a shape rather than a
 * colour: `square` steps (hold), `diamond` is a straight line (linear), `round`
 * is a curve (the eased presets and any custom Bezier). Reading a lane's motion
 * then takes no click.
 */
export type KeyShape = 'square' | 'diamond' | 'round';

export function keyShape(key: Keyframe | undefined): KeyShape {
  if (!key) return 'diamond';
  if (key.bezier) return 'round';
  const ease = key.ease ?? DEFAULT_EASE;
  if (ease === 'hold') return 'square';
  if (ease === 'linear') return 'diamond';
  return 'round';
}

/**
 * Value of a channel at a clip-local time (ms). A constant channel returns
 * itself; a keyframed channel holds at the first/last value outside its range
 * and eases between bracketing keyframes inside it. Keyframes are assumed sorted
 * by `t` (the edit helpers keep them so).
 */
export function sampleChannel(channel: Channel, localMs: number): number {
  if (!Array.isArray(channel)) return channel;
  const keys = channel;
  if (keys.length === 0) return 0;
  const first = keys[0]!;
  if (keys.length === 1 || localMs <= first.t) return first.value;
  const last = keys[keys.length - 1]!;
  if (localMs >= last.t) return last.value;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (localMs < b.t) {
      const a = keys[i - 1]!;
      const span = b.t - a.t;
      const p = span <= 0 ? 1 : (localMs - a.t) / span;
      return a.value + (b.value - a.value) * easeProgress(a, p);
    }
  }
  return last.value;
}

/** Two keyframe times within this many ms are treated as the same key (replace, not add). */
const KEYFRAME_EPSILON_MS = 1;

/**
 * Set a keyframe at clip-local time `t`, returning a new sorted channel. If a
 * key already sits at `t` (within a 1 ms epsilon) its value/easing is replaced;
 * otherwise the key is inserted in order. Given a constant channel, the constant
 * is not lost — it seeds a first keyframe so animating a property never jumps.
 */
export function setKeyframe(channel: Channel, t: number, value: number, ease?: EaseId): Keyframe[] {
  const key: Keyframe = ease ? { t, value, ease } : { t, value };
  const base: Keyframe[] = Array.isArray(channel)
    ? channel.map((k) => ({ ...k }))
    : [{ t: 0, value: channel }];
  const at = base.findIndex((k) => Math.abs(k.t - t) < KEYFRAME_EPSILON_MS);
  if (at >= 0) base[at] = { ...base[at], ...key };
  else base.push(key);
  return base.sort((a, b) => a.t - b.t);
}

/**
 * Remove the keyframe at clip-local time `t` (within epsilon). A surviving
 * keyframe keeps the property animated (one diamond stays one diamond); only
 * removing the LAST keyframe collapses the channel back to a constant of that
 * key's value, so a de-animated property stays exactly where its final key left
 * it. A no-op (returns the same reference) when no key sits at `t`.
 */
export function removeKeyframe(channel: Channel, t: number): Channel {
  if (!Array.isArray(channel)) return channel;
  const removed = channel.find((k) => Math.abs(k.t - t) < KEYFRAME_EPSILON_MS);
  if (!removed) return channel;
  const remaining = channel.filter((k) => k !== removed);
  return remaining.length ? remaining : removed.value;
}

/**
 * Shift every keyframe of a channel by `deltaMs` — what an edit that moves the
 * clip's local origin (a left trim, the right half of a split) owes its
 * animation, so the motion stays welded to the frames it was authored on
 * instead of sliding against them.
 */
export function shiftChannel(channel: Channel, deltaMs: number): Channel {
  if (!Array.isArray(channel) || deltaMs === 0) return channel;
  return channel.map((k) => ({ ...k, t: k.t + deltaMs }));
}

/**
 * The part of a channel that falls inside the clip-local window
 * `[startMs, endMs]`, rebased so `startMs` becomes t = 0 — the razor applied to
 * an animation. Each half of a split keeps only its own keys, and boundary keys
 * are synthesized from the sampled value so neither half jumps at the cut: what
 * played before the split plays after it, on both sides.
 *
 * The synthesized key inherits the easing of the segment it lands in, which is
 * an approximation — half of a cubic-Bezier is not that same Bezier — but it
 * keeps the shape of the motion, and the values at both ends are exact.
 */
export function sliceChannel(channel: Channel, startMs: number, endMs: number): Channel {
  if (!Array.isArray(channel) || channel.length === 0) return channel;
  const inWindow = (t: number) => t > startMs + KEYFRAME_EPSILON_MS && t < endMs - KEYFRAME_EPSILON_MS;
  // The key governing the segment each boundary falls in, for its easing.
  const governing = (t: number) =>
    channel.filter((k) => k.t <= t + KEYFRAME_EPSILON_MS).at(-1) ?? channel[0]!;
  const boundary = (t: number): Keyframe => {
    const exact = channel.find((k) => Math.abs(k.t - t) < KEYFRAME_EPSILON_MS);
    if (exact) return { ...exact, t: t - startMs };
    const src = governing(t);
    const key: Keyframe = { t: t - startMs, value: sampleChannel(channel, t) };
    if (src.bezier) key.bezier = [...src.bezier];
    else if (src.ease) key.ease = src.ease;
    return key;
  };
  const keys: Keyframe[] = channel.filter((k) => inWindow(k.t)).map((k) => ({ ...k, t: k.t - startMs }));
  // Boundary keys only where the animation actually crosses the edge. A window
  // that starts before the first key (or ends after the last) already holds
  // that value on its own, and a spurious flat key would just clutter the lane.
  if (channel.some((k) => k.t <= startMs + KEYFRAME_EPSILON_MS)) keys.unshift(boundary(startMs));
  if (channel.some((k) => k.t >= endMs - KEYFRAME_EPSILON_MS)) keys.push(boundary(endMs));
  return keys.length ? keys : channel[0]!.value;
}

/**
 * Scale every keyframe time by `factor` — what a speed change owes its
 * animation. Clip-local time is post-speed, so halving a clip's speed doubles
 * the stretch its keys span; scaling them keeps each key on the media frame it
 * was authored on, and the motion slows down with the picture instead of
 * finishing early and freezing.
 */
export function scaleChannel(channel: Channel, factor: number): Channel {
  if (!Array.isArray(channel) || factor === 1) return channel;
  return channel.map((k) => ({ ...k, t: k.t * factor }));
}
