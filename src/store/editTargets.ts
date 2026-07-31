import type { Project } from '../types';
import { findClip } from './projectOps';
import { audioTarget } from '../effects/apply';

/**
 * The clips an edit aimed at `clipId` must reach.
 *
 * The inspector shows one clip - the primary of the selection - and every one
 * of its controls names that clip. Without this expansion, selecting five
 * shots and dragging a slider would change exactly one of them, which is not
 * what a selection means: a property edit belongs to everything selected.
 *
 * A clip can also be addressed INDIRECTLY. A linked video clip delegates its
 * sound to the audio clip on the lane below (it is silent in the mix), so the
 * inspector's volume/balance/effects controls edit that partner. Naming a
 * delegate therefore maps every selected clip onto its OWN delegate, rather
 * than stacking the whole selection's change onto a single audio lane.
 *
 * Anything the selection does not contain edits alone: direct manipulation - a
 * timeline fade handle, a cue row in the subtitle list - names the one clip it
 * means, and those surfaces collapse the selection onto it anyway.
 */
export function editTargets(
  project: Project,
  selectedClipIds: string[],
  clipId: string,
): string[] {
  if (selectedClipIds.length < 2) return [clipId];
  if (selectedClipIds.includes(clipId)) return selectedClipIds;
  const delegates = selectedClipIds.map((id) => {
    const found = findClip(project, id);
    return found ? audioTarget(project, found.clip).id : id;
  });
  // Deduped: several selected clips can share one audio partner (or resolve to
  // themselves), and the same clip must not be edited twice in one pass.
  return delegates.includes(clipId) ? [...new Set(delegates)] : [clipId];
}
