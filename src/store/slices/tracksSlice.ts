import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { uid } from '../../lib/id';
import { insertTrack } from '../projectOps';

export function createTracksSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory, pruneSelection }: SliceHelpers,
): Pick<
  EditorState,
  | 'addTrack'
  | 'updateTrack'
  | 'removeTrack'
  | 'moveTrack'
  | 'toggleTrackMuted'
  | 'toggleTrackHidden'
  | 'toggleTrackLocked'
> {
  return {
    addTrack: (kind) =>
      withHistory((p) => {
        insertTrack(p, { id: uid('track'), kind, clips: [] });
      }),

    removeTrack: (trackId) => {
      withHistory((p) => {
        p.tracks = p.tracks.filter((t) => t.id !== trackId);
        // Dissolve the A/V links the removal left partnerless: an orphaned
        // linkId keeps delegating a video's audio to a clip that no longer
        // exists (silent forever, and neither Unlink nor Link applies). A link
        // still shared by 2+ clips (multi-lane audio group) stays intact.
        const linkCounts = new Map<string, number>();
        for (const track of p.tracks)
          for (const clip of track.clips)
            if (clip.linkId) linkCounts.set(clip.linkId, (linkCounts.get(clip.linkId) ?? 0) + 1);
        for (const track of p.tracks)
          for (const clip of track.clips)
            if (clip.linkId && (linkCounts.get(clip.linkId) ?? 0) < 2) delete clip.linkId;
      });
      pruneSelection();
    },

    moveTrack: (trackId, dir) =>
      withHistory((p) => {
        const i = p.tracks.findIndex((t) => t.id === trackId);
        const j = i + dir;
        if (i === -1 || j < 0 || j >= p.tracks.length) return;
        [p.tracks[i], p.tracks[j]] = [p.tracks[j]!, p.tracks[i]!];
      }),

    toggleTrackMuted: (trackId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) track.muted = !track.muted;
      }),

    toggleTrackHidden: (trackId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) track.hidden = !track.hidden;
      }),

    toggleTrackLocked: (trackId) => {
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) track.locked = !track.locked;
      });
      // Locking a track with a live selection on it would leave clips selected
      // that no longer accept edits: drop them now.
      const locked = new Set<string>();
      for (const track of get().project.tracks) {
        if (track.locked) for (const clip of track.clips) locked.add(clip.id);
      }
      const ids = get().selectedClipIds.filter((id) => !locked.has(id));
      if (ids.length !== get().selectedClipIds.length) get().setSelectedClips(ids);
    },

    updateTrack: (trackId, patch) => {
      const p = get().project;
      const tracks = p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t));
      set({ project: { ...p, tracks } });
    },
  };
}
