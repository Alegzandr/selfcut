/**
 * Which decoded frame belongs to an instant.
 *
 * Shared by the two decode paths - the preview cursor and the export reader -
 * because a preview that judges the cadence of a render has to pick the same
 * frame the render will.
 */

/**
 * Tie-break slack, in seconds, on the comparison below.
 *
 * At an exact rate ratio a target can land exactly on the midpoint between two
 * source frames (60 fps footage read at 120 fps puts every odd output frame
 * there). Resolving those ties towards the current frame is what makes the
 * cadence regular - each source frame shown exactly twice rather than an
 * alternating 1/3 split - so the comparison has to settle them one way,
 * deterministically, instead of leaving them to the last bit of a division.
 *
 * 1 microsecond is the granularity WebCodecs itself stores timestamps at, so
 * two instants closer than this are the same instant by definition - and it is
 * four orders of magnitude below the shortest frame we ever handle.
 */
export const FRAME_MATCH_EPSILON_SEC = 1e-6;

/**
 * Is `nextSec` the better frame for `targetSec` than `currentSec`, i.e. should
 * a sequential reader advance onto it?
 *
 * Nearest, not "the last frame starting at or before the target": a source
 * timestamp is a container tick, and a container often cannot express the rate
 * it carries. Matroska commonly runs a 1 ms timescale, so 120 fps footage
 * reports 0, 8, 17, 25, 33, 42 ms where the frames really fall on 8.333,
 * 16.667, 25, 33.333, 41.667. Against a target built from the exact rate, a
 * floor rule rejects the frame at 17 ms for the target at 16.667, repeats its
 * predecessor, then skips it outright at the next target: one frame in three
 * duplicated, one source frame in three never shown. The output is a true
 * 120 fps stream and still stutters.
 *
 * Half a frame of tick rounding stays well inside the midpoint, so picking the
 * nearest frame reads such a source back at full cadence - and it is the right
 * answer at unrelated rates too: a frame shown up to half a frame early beats a
 * frame shown twice.
 */
export function advancesToNextFrame(currentSec: number, nextSec: number, targetSec: number): boolean {
  const midpoint = (currentSec + nextSec) / 2;
  return targetSec > midpoint + FRAME_MATCH_EPSILON_SEC;
}
