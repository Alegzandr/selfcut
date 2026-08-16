/**
 * When the debounced project save is actually allowed to run.
 *
 * Its own module rather than a helper inside persistence.ts, so the policy can
 * be tested without pulling in IndexedDB, the store and the media pipeline.
 */

/** Quiet period a burst of edits is coalesced over. */
export const SAVE_DEBOUNCE_MS = 500;

/**
 * Longest a project change may sit unwritten, however busy the editor is.
 *
 * A plain debounce restarts on every change, and an editor at work never
 * produces a 500 ms gap: dragging a clip, scrubbing, or dropping a batch of
 * files updates the store continuously, so the write kept being pushed forward
 * and the timeline could stay unwritten for minutes. That is invisible until
 * the tab goes away without a clean unload - which is what a memory-starved
 * session does - and then the restore comes back to whatever the last quiet
 * moment held, with the newest clips simply missing.
 *
 * Two seconds keeps the coalescing the debounce exists for (a drag still costs
 * a handful of writes, not one per pointermove) while bounding what an unclean
 * exit can cost to a couple of seconds of work.
 */
export const SAVE_MAX_WAIT_MS = 2000;

/**
 * Delay before the pending project write, given when the oldest unwritten
 * change was made.
 */
export function nextSaveDelay(
  now: number,
  oldestPendingAt: number,
  debounceMs: number = SAVE_DEBOUNCE_MS,
  maxWaitMs: number = SAVE_MAX_WAIT_MS,
): number {
  const deadline = oldestPendingAt + maxWaitMs;
  return Math.max(0, Math.min(debounceMs, deadline - now));
}
