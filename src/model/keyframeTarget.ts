/**
 * Addressing a keyframable property, wherever the clip actually keeps it.
 *
 * Two families of property can animate, and they are stored differently. The
 * transform props live in `clip.animation[prop]` as a plain `Keyframe[]`, kept
 * apart from `clip.transform` so the compositor's static reads stay numbers. The
 * colour params live in `clip.color[param]`, which is a `Channel` - a number
 * until it is keyframed, an array afterwards.
 *
 * That asymmetry is real and worth keeping: a colour param has no separate
 * static field to fall back to, and a transform prop does. What is not worth
 * keeping is every caller knowing about it. This module is the one place that
 * does, so the store actions, the inspector and the timeline can all say "the
 * scale property" and "the contrast property" in the same breath.
 */
import type { AnimatableProp, Channel, Clip, ClipColor, ColorProp, Keyframe } from '../types';
import { DEFAULT_TRANSFORM } from './clip';

export type { ColorProp, KeyframeProp } from '../types';

import type { KeyframeProp } from '../types';

/** The colour params at runtime, in inspector order. */
export const COLOR_PROPS: ColorProp[] = [
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'vignette',
  'blur',
];

const COLOR_PROP_SET = new Set<string>(COLOR_PROPS);

export function isColorProp(prop: KeyframeProp): prop is ColorProp {
  return COLOR_PROP_SET.has(prop);
}

/** The channel a property reads from, or undefined when the clip carries none. */
export function channelOf(clip: Clip, prop: KeyframeProp): Channel | undefined {
  return isColorProp(prop) ? clip.color?.[prop] : clip.animation?.[prop];
}

/** The keyframes of a property, or undefined when it is constant. */
export function keyframesOf(clip: Clip, prop: KeyframeProp): Keyframe[] | undefined {
  const ch = channelOf(clip, prop);
  return Array.isArray(ch) && ch.length ? ch : undefined;
}

/**
 * The value a property currently shows when it is not animated - what a first
 * keyframe is seeded from, so enabling animation never makes the clip jump.
 */
export function staticValueOf(clip: Clip, prop: KeyframeProp): number {
  if (isColorProp(prop)) {
    const ch = clip.color?.[prop];
    // Every colour param is identity at 0, which is also its absent value.
    return typeof ch === 'number' ? ch : 0;
  }
  if (prop === 'opacity') return 1;
  const tf = clip.transform ?? DEFAULT_TRANSFORM;
  return prop === 'rotation' ? (tf.rotation ?? 0) : tf[prop];
}

/**
 * Write a channel back onto a clip, mutating it - meant for use inside an immer
 * draft. Passing a number de-animates the property, and this is where the two
 * storage shapes stop being the caller's problem:
 *
 * - a colour param simply holds the number, since `Channel` is either;
 * - a transform prop drops out of `animation` and its value lands in
 *   `transform`, because that is where the static read sites look;
 * - `opacity` is the exception with no static counterpart, so it stays a
 *   one-keyframe channel rather than losing the value it collapsed to.
 */
export function writeChannel(clip: Clip, prop: KeyframeProp, next: Channel): void {
  if (isColorProp(prop)) {
    const color: ClipColor = { ...clip.color, [prop]: next };
    clip.color = color;
    return;
  }
  if (Array.isArray(next)) {
    clip.animation = { ...clip.animation, [prop]: next };
    return;
  }
  const anim = { ...clip.animation };
  delete anim[prop];
  clip.animation = Object.keys(anim).length ? anim : undefined;
  if (prop === 'opacity') {
    clip.animation = { ...clip.animation, opacity: [{ t: 0, value: next }] };
    return;
  }
  const tf = clip.transform ? { ...clip.transform } : structuredClone(DEFAULT_TRANSFORM);
  tf[prop] = next;
  clip.transform = tf;
}

/**
 * Every keyframed property of a clip, both families. Callers that walk a clip's
 * keyframes (retiming, re-easing, box selection) go through this so neither
 * family can be silently forgotten.
 */
export function animatedProps(clip: Clip): { prop: KeyframeProp; keys: Keyframe[] }[] {
  const out: { prop: KeyframeProp; keys: Keyframe[] }[] = [];
  for (const [prop, keys] of Object.entries(clip.animation ?? {})) {
    if (keys?.length) out.push({ prop: prop as AnimatableProp, keys });
  }
  for (const prop of COLOR_PROPS) {
    const ch = clip.color?.[prop];
    if (Array.isArray(ch) && ch.length) out.push({ prop, keys: ch });
  }
  return out;
}
