/**
 * Which A/V link groups the timeline should light up.
 *
 * A linked pair moves, trims and deletes as one, but nothing on screen said
 * WHICH audio clip belongs to which shot - the link badge only says "this one
 * is linked to something". Selecting or hovering one member now tints every
 * member of its group.
 *
 * `ClipView` asks this per clip on every store change, so the scan over the
 * tracks is memoised on the two references it depends on: rebuilding the set
 * only when the selection or the project's tracks actually change.
 */
import { EditorState } from '../store/editorState';

let cache: { key: unknown[]; set: ReadonlySet<string> } | null = null;

/** The `linkId`s of every currently selected clip. */
export function selectedLinkIds(s: EditorState): ReadonlySet<string> {
  const key = [s.selectedClipIds, s.project.tracks];
  if (cache && cache.key[0] === key[0] && cache.key[1] === key[1]) return cache.set;
  const out = new Set<string>();
  if (s.selectedClipIds.length > 0) {
    const selected = new Set(s.selectedClipIds);
    for (const track of s.project.tracks) {
      for (const clip of track.clips) {
        if (clip.linkId != null && selected.has(clip.id)) out.add(clip.linkId);
      }
    }
  }
  cache = { key, set: out };
  return out;
}

/** True when `linkId` names a group the user is pointing at or has selected. */
export function linkGroupActive(s: EditorState, linkId: string | undefined): boolean {
  if (linkId == null) return false;
  return s.hoveredLinkId === linkId || selectedLinkIds(s).has(linkId);
}
