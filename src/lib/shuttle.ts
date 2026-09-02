import { MAX_SHUTTLE_RATE, MIN_SHUTTLE_RATE } from '../app/config';

/** What a J or L press does to the transport: the new rate, and whether to run. */
export interface ShuttleStep {
  rate: number;
  playing: boolean;
}

/**
 * The JKL ladder, as one pure step.
 *
 * J and L are mirrors of each other, which is what every NLE's shuttle is and
 * what this app's pair was missing: L only ever went forward, so J had nothing
 * to be the opposite of and was left stepping the playhead back a second while
 * paused. Here `dir` is the direction the pressed key argues for (+1 for L, -1
 * for J) and the rule is the same in both directions:
 *
 * - Stopped: start playing at 1x in the key's own direction. J from a paused
 *   transport is what plays backwards.
 * - Already going that way: double the speed, up to MAX_SHUTTLE_RATE. From a
 *   slow rung, the first press comes back to 1x rather than doubling into
 *   0.5x - the key means "faster", and 1x is the speed it means first.
 * - Going the other way: halve the speed, for slow review, down to
 *   MIN_SHUTTLE_RATE - and one more press past that turns around at 1x. The
 *   ladder therefore crosses from one direction to the other rather than
 *   sticking at its slowest rung, which is where the old J dead-ended.
 *
 * The rate carries the direction in its sign, so nothing else in the transport
 * has to know which key was pressed.
 */
export function shuttleStep(rate: number, playing: boolean, dir: -1 | 1): ShuttleStep {
  if (!playing) return { rate: dir, playing: true };
  const speed = Math.abs(rate);
  const forward = rate >= 0 ? 1 : -1;
  if (forward === dir) {
    return { rate: dir * (speed < 1 ? 1 : Math.min(MAX_SHUTTLE_RATE, speed * 2)), playing: true };
  }
  if (speed > MIN_SHUTTLE_RATE) return { rate: forward * (speed / 2), playing: true };
  return { rate: dir, playing: true };
}
