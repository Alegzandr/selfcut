/**
 * Geometry of the velocity line drawn across a clip: the pure mapping between a
 * playback rate and a height, and back. Kept out of the component so the scale
 * can be reasoned about (and tested) on its own, the way `snapping` and
 * `trackHeight` are.
 *
 * The scale is LOGARITHMIC, with 1x in the middle. Vegas draws its velocity
 * envelope on a linear percentage axis, which puts every slow motion worth
 * having - 0.5x, 0.25x - inside the bottom eighth of the line while 2x through
 * 4x get the whole upper half. On a log axis 0.5x and 2x sit the same distance
 * either side of unity, which is what "half speed" and "double speed" actually
 * mean to the person reading the line.
 */

/**
 * Rates the axis spans, as octaves either side of unity. Two octaves reaches
 * 0.25x and 4x: past that the line pins to its edge and the numeric readout
 * carries the value. Widening it to the full 0.1x..8x the model allows would
 * buy the rarest rates a little precision and cost every common one a lot.
 */
const OCTAVES = 2;

/** Fraction of the clip's height, 0 at the bottom, for a playback rate. */
export function rateToLinePos(rate: number): number {
  if (!(rate > 0)) return 0.5;
  const octave = Math.log2(rate) / OCTAVES;
  return Math.min(1, Math.max(0, (octave + 1) / 2));
}

/** The rate a height fraction stands for - the inverse of `rateToLinePos`. */
export function linePosToRate(pos: number): number {
  const clamped = Math.min(1, Math.max(0, pos));
  return 2 ** ((clamped * 2 - 1) * OCTAVES);
}

/**
 * Rates worth a detent while dragging. The musical ones, so a drag lands on a
 * round half or double instead of 0.51x - and unity above all, which is where a
 * ramp is most often meant to start and end.
 */
export const RATE_DETENTS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4] as const;

/**
 * Pull in fractions of the axis height. Generous enough that unity is easy to
 * hit on a 36 px track, tight enough that the space between detents stays
 * reachable.
 */
const DETENT_PULL = 0.022;

/** A rate snapped to the nearest detent within the pull, or itself. */
export function snapRate(rate: number): number {
  const pos = rateToLinePos(rate);
  let best = rate;
  let bestDistance = DETENT_PULL;
  for (const detent of RATE_DETENTS) {
    const distance = Math.abs(rateToLinePos(detent) - pos);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = detent;
    }
  }
  return best;
}

/**
 * Inset, in px, kept clear at the top and bottom of a clip so a point dragged
 * to an extreme still has its grab band inside the clip. The clip hides its
 * overflow: without this, a point at 0.25x hangs below the body and becomes
 * unreachable - the same trap the volume line documents.
 */
export const LINE_INSET_PX = 6;

/** `top` in px for a rate, inside a clip `height` px tall. */
export function rateToTopPx(rate: number, height: number): number {
  const usable = Math.max(1, height - LINE_INSET_PX * 2);
  return LINE_INSET_PX + (1 - rateToLinePos(rate)) * usable;
}

/** The rate a `top` in px stands for - the inverse of `rateToTopPx`. */
export function topPxToRate(top: number, height: number): number {
  const usable = Math.max(1, height - LINE_INSET_PX * 2);
  return linePosToRate(1 - (top - LINE_INSET_PX) / usable);
}
