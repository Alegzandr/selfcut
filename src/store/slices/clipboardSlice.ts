import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState, ClipboardItem } from '../editorState';
import { uid } from '../../lib/id';
import { ensureTrack, findClip } from '../projectOps';

export function createClipboardSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<EditorState, 'copyClips' | 'cutClips' | 'pasteAtPlayhead'> {
  return {
    copyClips: (clipIds) => {
      const project = get().project;
      const found = clipIds
        .map((id) => findClip(project, id))
        .filter((f): f is NonNullable<typeof f> => f !== null && f !== undefined);
      if (found.length === 0) return;

      // Relative to the earliest clip, not to the playhead: the copy has to
      // survive a seek between Ctrl+C and Ctrl+V.
      const anchorMs = Math.min(...found.map((f) => f.clip.timelineStartMs));

      // An A/V pair copied whole keeps its link (re-keyed at paste time); half a
      // pair pastes standalone, so it cannot attach to the original's partner.
      const linkCounts = new Map<string, number>();
      for (const f of found) {
        if (f.clip.linkId) linkCounts.set(f.clip.linkId, (linkCounts.get(f.clip.linkId) ?? 0) + 1);
      }

      const items: ClipboardItem[] = found.map((f) => {
        const clip = structuredClone(f.clip);
        if (!clip.linkId || (linkCounts.get(clip.linkId) ?? 0) < 2) delete clip.linkId;
        return { clip, kind: f.track.kind, offsetMs: f.clip.timelineStartMs - anchorMs };
      });
      set({ clipboard: { items } });
    },

    cutClips: (clipIds) => {
      get().copyClips(clipIds);
      get().deleteClips(clipIds, false);
    },

    pasteAtPlayhead: () => {
      const { clipboard, currentTimeMs } = get();
      if (!clipboard || clipboard.items.length === 0) return;
      const newIds = clipboard.items.map(() => uid('clip'));
      // Re-keyed so a pasted pair links to itself and not to the clips it came from.
      const linkIds = new Map<string, string>();

      // The earliest pasted clip holds the playhead position (priority) when
      // overlaps settle; the rest keep their offsets from it.
      withHistory((p) => {
        clipboard.items.forEach((item, i) => {
          const track = ensureTrack(p, item.kind, item.clip.trackId);
          const clip = structuredClone(item.clip);
          if (clip.linkId) {
            const next = linkIds.get(clip.linkId) ?? uid('link');
            linkIds.set(clip.linkId, next);
            clip.linkId = next;
          }
          track.clips.push({
            ...clip,
            id: newIds[i]!,
            trackId: track.id,
            timelineStartMs: currentTimeMs + item.offsetMs,
          });
        });
      }, newIds[0]);
      set({ selectedClipId: newIds[newIds.length - 1]!, selectedClipIds: newIds });
    },
  };
}
