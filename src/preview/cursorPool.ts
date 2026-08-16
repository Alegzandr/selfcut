/**
 * How many clips may hold a live decode cursor at once.
 *
 * Every cursor owns a configured `VideoDecoder` in the frame worker plus the
 * one or two decoded samples it is holding - roughly 12 MB per 4K frame, and
 * browsers only give a page a handful of hardware decoders before falling back
 * to software. The preview used to create one per clip the playhead had ever
 * crossed and release it only when that clip was deleted, so half an hour of
 * cutting a multi-file project ended with dozens of live decoders competing for
 * the same hardware: the picture stuttered no matter how far the preview
 * resolution was dropped, because the cost was decode, not composite.
 *
 * The number is a compromise: high enough that a stack of layered tracks and a
 * crossfade never evict a clip that is still on screen (both are bounded by how
 * many clips can be visible at one instant, which is small), low enough to stay
 * well inside what a browser will decode in parallel.
 */
export const MAX_LIVE_CURSORS = 8;

/**
 * Never fewer than this, whatever the arithmetic says: a crossfade between two
 * clips on two stacked tracks needs four cursors at the same instant, and
 * evicting one that is on screen would dispose the decoder about to be asked
 * for the next frame. Below this the pool stops being a cache and starts being
 * a bug.
 */
export const MIN_LIVE_CURSORS = 4;

/**
 * Bytes one decoded frame of a given size occupies.
 *
 * 1.5 bytes per pixel is 4:2:0 8-bit, which is what essentially all delivery
 * codecs decode to: 12.4 MB for a 4K frame, 3.1 MB for 1080p. A 10-bit source
 * is half again as much, and the caller passes that in rather than this
 * guessing.
 */
export function frameBytes(width: number, height: number, bytesPerPixel = 1.5): number {
  return Math.max(1, Math.round(width * height * bytesPerPixel));
}

/**
 * How much memory the decoded-frame pool may hold.
 *
 * The count-based cap was blind to what it was capping. Eight cursors is
 * ~200 MB of 4K frames on a machine that may only have 2 GB of RAM to give the
 * whole tab, and 25 MB of 720p frames on a workstation that could hold ten
 * times as many. Deriving the cap from the device, exactly as the audio cache
 * already does, makes the same constant mean the same thing on both.
 */
export function cursorBudgetBytes(deviceMemoryGb?: number): number {
  // `deviceMemory` is coarse (0.25 / 0.5 / 1 / 2 / 4 / 8) and capped at 8 for
  // fingerprinting reasons, so a 64 GB workstation reports 8. Undefined
  // (Firefox, Safari) assumes the same 4 GB midpoint the audio budget does.
  const share = (deviceMemoryGb ?? 4) * 0.08 * 1024 * 1024 * 1024;
  return Math.min(768 * 1024 * 1024, Math.max(96 * 1024 * 1024, share));
}

/**
 * How many cursors fit in the budget, given the size of the frames in play.
 *
 * Two frames per cursor: the one being drawn and the one the decoder is
 * producing. Clamped both ways, so the pool never drops below what a legal
 * layout needs on screen, and never grows past what a browser will decode in
 * parallel however much RAM the machine has.
 */
export function maxLiveCursors(largestFrameBytes: number, deviceMemoryGb?: number): number {
  const fits = Math.floor(cursorBudgetBytes(deviceMemoryGb) / Math.max(1, largestFrameBytes * 2));
  return Math.min(MAX_LIVE_CURSORS, Math.max(MIN_LIVE_CURSORS, fits));
}

/**
 * Which cursors to release, least-recently-used first.
 *
 * `ordered` is every live cursor id from least to most recently drawn; `keep`
 * are the clips visible at the instant being drawn, which are never candidates
 * however old their last use - evicting one would dispose the decoder that is
 * about to be asked for the very next frame.
 *
 * Pure, so the policy can be tested without a worker or a decoder behind it.
 */
export function selectCursorEvictions(
  ordered: Iterable<string>,
  keep: ReadonlySet<string>,
  max: number = MAX_LIVE_CURSORS,
): string[] {
  const all = [...ordered];
  let over = all.length - max;
  if (over <= 0) return [];
  const doomed: string[] = [];
  for (const id of all) {
    if (over <= 0) break;
    if (keep.has(id)) continue;
    doomed.push(id);
    over--;
  }
  return doomed;
}
