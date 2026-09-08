import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import type { Track } from '../../types';
import { uid } from '../../lib/id';
import { insertTrack } from '../projectOps';
import { trackEffectPatch } from '../../effects/apply';

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
  | 'toggleTrackSolo'
  | 'renameTrack'
  | 'toggleTrackExpanded'
  | 'applyEffectToTrack'
  | 'setTrackColorLive'
  | 'setTrackLut'
  | 'setTrackLutIntensity'
  | 'resetTrackColor'
  | 'setTrackAudioFxAmount'
  | 'removeTrackAudioFx'
> {
  /**
   * Rewrite one track, copy-on-write and WITHOUT a history entry - the shape
   * every live control needs. A slider drag writes on each pointermove and is
   * turned into a single undo step by the gesture around it (see `beginGesture`),
   * exactly as the clip colour sliders already work.
   */
  const patchTrackLive = (trackId: string, fn: (track: Track) => Partial<Track>) => {
    const p = get().project;
    const tracks = p.tracks.map((tr) => (tr.id === trackId ? { ...tr, ...fn(tr) } : tr));
    set({ project: { ...p, tracks } });
  };

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

    toggleTrackSolo: (trackId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) track.solo = !track.solo;
      }),

    renameTrack: (trackId, name) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (!track) return;
        const trimmed = name.trim();
        if (trimmed) track.name = trimmed;
        else delete track.name;
      }),

    updateTrack: (trackId, patch) => {
      const p = get().project;
      const tracks = p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t));
      set({ project: { ...p, tracks } });
    },

    applyEffectToTrack: (trackId, effectId) => {
      const track = get().project.tracks.find((tr) => tr.id === trackId);
      if (!track) return false;
      const patch = trackEffectPatch(track, effectId);
      // Refused by the lane, or already there: no undo step for a no-op, and a
      // false the caller can turn into a word about why nothing happened.
      if (!patch) return false;
      withHistory((p) => {
        const target = p.tracks.find((tr) => tr.id === trackId);
        if (target) Object.assign(target, patch);
      });
      return true;
    },

    setTrackColorLive: (trackId, prop, value) =>
      patchTrackLive(trackId, (track) => ({ color: { ...track.color, [prop]: value } })),

    setTrackLut: (trackId, lutId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (!track) return;
        if (!lutId) {
          if (track.color) delete track.color.lut;
          return;
        }
        // A LUT picked on a lane with no grade yet starts the grade: the table
        // is the base a lane is then tuned on top of, not a tweak of one.
        track.color = { ...track.color, lut: { id: lutId, intensity: 1 } };
      }),

    setTrackLutIntensity: (trackId, intensity) =>
      patchTrackLive(trackId, (track) =>
        track.color?.lut
          ? { color: { ...track.color, lut: { ...track.color.lut, intensity } } }
          : {},
      ),

    resetTrackColor: (trackId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) delete track.color;
      }),

    setTrackAudioFxAmount: (trackId, type, amount) =>
      patchTrackLive(trackId, (track) => ({
        audioFx: (track.audioFx ?? []).map((fx) => (fx.type === type ? { ...fx, amount } : fx)),
      })),

    removeTrackAudioFx: (trackId, type) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (!track) return;
        const next = (track.audioFx ?? []).filter((fx) => fx.type !== type);
        // An empty chain is no chain: leaving `[]` behind would make every
        // "does this lane have effects" check answer yes for a lane with none.
        if (next.length) track.audioFx = next;
        else delete track.audioFx;
      }),

    toggleTrackExpanded: (trackId) => {
      const cur = get().expandedTrackIds;
      set({
        expandedTrackIds: cur.includes(trackId)
          ? cur.filter((id) => id !== trackId)
          : [...cur, trackId],
      });
    },
  };
}
