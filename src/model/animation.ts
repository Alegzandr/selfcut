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
