/**
 * The grid decoded audio is cut on.
 *
 * A source track used to be decoded whole, into one `AudioBuffer` - instant to
 * schedule, and identical in the preview and the export, but ~23 MB per stereo
 * minute in ONE indivisible allocation. An hour-long screen recording, which is
 * exactly what this editor exists to cut down, is 1.4 GB of it. Nothing could
 * be freed to make that fit, so the import path had to warn about the file
 * before it was ever played and the remedy it offered ("shorten the clip") did
 * not even work: the decode covered the whole source whatever the trim was.
 *
 * So audio is decoded in fixed-length pieces instead, addressed by index on a
 * grid that starts at the source's zero. Everything downstream asks for a time
 * RANGE and gets the pieces covering it.
 *
 * The grid is what makes the cache useful rather than merely bounded:
 *
 * - a piece is shared by every clip that reads that part of the source, so
 *   twenty razor cuts in one recording decode each region once;
 * - dragging a trim handle moves the range but rarely changes which pieces it
 *   lands on, so the common edit costs nothing;
 * - what is held is a function of what is being PLAYED, not of what was
 *   imported, which is the whole point.
 *
 * Pure module: no browser, no decoding, no state. The cache in `mediaCache.ts`
 * owns the pieces themselves; this owns where their edges are.
 */

/**
 * Length of one piece.
 *
 * 30 s is ~11.5 MB of 48 kHz stereo float - small enough that a decode is never
 * the allocation that fails, and that a budget of a few hundred megabytes holds
 * a comfortable window around the playhead. Smaller pieces would mean more
 * seeks and more scheduled nodes for the same sound; larger ones bring back the
 * problem this exists to solve.
 */
export const SEGMENT_MS = 30_000;

/** One decoded piece of a source track. */
export interface AudioSegment {
  buffer: AudioBuffer;
  /**
   * Source timestamp of frame 0 of `buffer`, in ms - i.e. `index * SEGMENT_MS`.
   * Carried on the object because every consumer schedules against SOURCE time
   * (a clip's in point), and a buffer alone no longer knows where it starts.
   */
  startMs: number;
  /** Grid index, for cache keys and adjacency checks. */
  index: number;
}

/** Which piece a source timestamp falls in. */
export function segmentIndexAt(ms: number): number {
  return Math.floor(Math.max(0, ms) / SEGMENT_MS);
}

/** Source timestamp where a piece begins. */
export function segmentStartMs(index: number): number {
  return index * SEGMENT_MS;
}

/**
 * Every piece index covering `[fromMs, toMs)`, in order.
 *
 * An empty or inverted range covers nothing. A zero-length range at an exact
 * boundary is still nothing: a consumer asking for [t, t) wants no audio, and
 * returning the piece at t would decode 30 s for a request for none.
 */
export function segmentIndexes(fromMs: number, toMs: number): number[] {
  if (!(toMs > fromMs)) return [];
  const first = segmentIndexAt(fromMs);
  const last = segmentIndexAt(Math.max(0, toMs - 1e-6));
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/**
 * How many pieces a range spans, without materializing them.
 *
 * Used to size a prefetch against the cache budget before asking for anything -
 * the count is the question ("does this window fit?"), the pieces are the cost.
 */
export function segmentCount(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  return segmentIndexAt(Math.max(0, toMs - 1e-6)) - segmentIndexAt(fromMs) + 1;
}
