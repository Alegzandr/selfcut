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
