import { useReducedMotion } from 'framer-motion';
import type { TargetAndTransition } from 'framer-motion';

/**
 * The enter/exit motion of every panel that appears over the editor - sheets,
 * drawers, dialogs, toasts, dropdowns.
 *
 * It exists because of *how* the movement has to be spelled. Motion's `x`, `y`
 * and `scale` shorthands are animated on the main thread: each frame runs a
 * callback, writes a style and forces a commit, so the panel only moves as
 * smoothly as the rest of the app lets it. Opening a sheet is the worst moment
 * to ask for that - React is mounting the sheet's whole contents in the same
 * frames - and on a phone the slide visibly stutters. Motion *can* hand an
 * animation to the browser's own compositor, where nothing on the main thread
 * can stall it, but only for a fixed list of properties, and `x`/`y`/`scale`
 * are not on it: the property has to be `transform` itself. Measured on the
 * media drawer, moving to `transform` cut the main thread's work during the
 * open by 40%, and its compositing commits by 70%.
 *
 * The catch is that `reducedMotion="user"` (see `main.tsx`) recognises the
 * shorthands and not `transform`, so spelling it by hand at each call site
 * would quietly start sliding panels at people who asked for stillness. That is
 * the second reason this is one function: the reduced-motion branch is here,
 * once, and it keeps the old behaviour - the movement is dropped, the fade
 * stays, so panels appear and disappear rather than snapping.
 */
export type Hidden = {
  /** Offset before entering, in px (number) or of the panel's own size ('100%'). */
  x?: number | string;
  y?: number | string;
  scale?: number;
  opacity?: number;
};

export type EnterMotion = {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
};

/**
 * The transform both ends of an animation are written with: always the same
 * functions in the same order - `translate()` then `scale()`, which is the
 * order Motion itself composes them in - because a matching function list is
 * what lets the browser interpolate the two directly rather than decomposing
 * matrices. Tailwind's own `translate-*` and `rotate-*` utilities compile to
 * the standalone `translate`/`rotate` properties, so a panel can carry those
 * classes and still have its `transform` animated here without the two
 * fighting.
 */
function transformOf({ x = 0, y = 0, scale = 1 }: Hidden): string {
  const px = (v: number | string) => (typeof v === 'number' ? `${v}px` : v);
  return `translate(${px(x)}, ${px(y)}) scale(${scale})`;
}

/**
 * Spread onto the `m.*` element that enters and leaves:
 * `{...useEnterMotion({ y: '100%' })}`. `hidden` is where the panel comes from
 * and returns to; the visible end is always the panel at rest. Pass `exitTo`
 * where a panel leaves somewhere other than where it arrived from.
 */
export function useEnterMotion(hidden: Hidden, exitTo: Hidden = hidden): EnterMotion {
  const reduce = useReducedMotion();
  const travels = (state: Hidden) =>
    state.x !== undefined || state.y !== undefined || state.scale !== undefined;
  // Reduced motion drops what travels and keeps the fade, so a panel still
  // appears and disappears rather than snapping - the behaviour `reducedMotion`
  // gave these components while they were spelled with `x`/`y`/`scale`.
  const moves = !reduce && (travels(hidden) || travels(exitTo));

  const at = (state: Hidden): TargetAndTransition => ({
    ...(moves && { transform: transformOf(state) }),
    ...(state.opacity !== undefined && { opacity: state.opacity }),
  });

  return {
    initial: at(hidden),
    // At rest: no offset, no scale, fully opaque if this panel fades at all.
    animate: at({ opacity: hidden.opacity === undefined ? undefined : 1 }),
    exit: at(exitTo),
  };
}
