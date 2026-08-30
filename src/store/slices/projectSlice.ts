import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { MediaAsset } from '../../types';
import { isGeneratedClip, outputDimensions, reframedTransform } from '../../model';
import { createEmptyProject } from '../projectOps';
import { disposeAssetResources } from '../../media/mediaCache';
import { clearTranscodedAudio } from '../../lib/audioCache';
import { clearSubtitleCues } from '../../lib/subtitleCache';

export function createProjectSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<EditorState, 'setAspectRatio' | 'hydrate' | 'resetProject'> {
  return {
    /**
     * Switch the output ratio, and reframe with it.
     *
     * `fill` (the default, what a plain click does) rescales every clip still
     * carrying the automatic framing so it covers the new frame: turning a 16:9
     * project vertical is meant to give a full-bleed vertical video, not a
     * landscape strip floating in black. `fit` is the opposite - it puts those
     * clips back at the contain fit, bars included - and is what Shift+click and
     * the toast's toggle reach.
     *
     * Clips the user has framed by hand (moved, stretched, rotated, keyframed,
     * or scaled to anything but these two values) are never touched, whichever
     * mode this runs in. The whole pass sits in one `withHistory` entry, so a
     * single undo returns both the ratio and every scale it wrote.
     *
     * Returns how many clips it actually reframed: the caller offers the
     * "fill / fit" toggle only when the choice made a visible difference, so
     * picking a ratio in an empty project raises no toast about framing.
     */
    setAspectRatio: (a, framing = 'fill') => {
      const from = outputDimensions(get().project.aspectRatio);
      const to = outputDimensions(a);
      const assets = get().assets;
      let reframed = 0;
      withHistory((p) => {
        p.aspectRatio = a;
        for (const track of p.tracks) {
          if (track.kind !== 'video') continue;
          for (const clip of track.clips) {
            if (isGeneratedClip(clip)) continue;
            const next = reframedTransform(clip, assets[clip.assetId], from, to, framing);
            if (next) {
              clip.transform = next;
              reframed++;
            }
          }
        }
      });
      return reframed;
    },

    hydrate: (project, assets) => {
      const map: Record<string, MediaAsset> = {};
      for (const a of assets) map[a.id] = a;
      // Hydrating replaces the whole library, so every decoder registered for
      // the outgoing project is unreachable from here on. Free them all rather
      // than sparing ids the incoming project happens to reuse: that stale
      // input still points at the *previous* file. Anything still needed is
      // re-created on demand from the incoming asset's own File.
      for (const id of Object.keys(get().assets)) disposeAssetResources(id);
      set({
        // Projects saved before markers existed restore without the field.
        project: { ...project, markers: project.markers ?? [] },
        // The invariant everything relies on: the active id always equals the
        // open project's id. Set here, atomically, so the persistence layer sees
        // a switch (and adopts the new library instead of diff-deleting the old).
        currentProjectId: project.id,
        assets: map,
        past: [],
        future: [],
        selectedClipId: null,
        selectedClipIds: [],
        currentTimeMs: 0,
        loopRegion: null,
        seekVersion: get().seekVersion + 1,
      });
    },

    resetProject: () => {
      // Includes assets only the history still reaches - nothing survives a reset.
      const ids = new Set(Object.keys(get().assets));
      for (const entry of [...get().past, ...get().future])
        for (const id of Object.keys(entry.assets)) ids.add(id);
      for (const id of ids) disposeAssetResources(id);
      // Nothing survives a reset, so neither on-disk cache has an owner left
      // either. Not awaited: the new project must appear now, and a cache that
      // fails to clear is only wasted space the startup sweep will collect.
      void clearTranscodedAudio();
      void clearSubtitleCues();
      const fresh = createEmptyProject();
      set({
        project: fresh,
        currentProjectId: fresh.id,
        assets: {},
        past: [],
        future: [],
        selectedClipId: null,
        selectedClipIds: [],
        clipboard: null,
        inspectorOpen: false,
        currentTimeMs: 0,
        loopRegion: null,
        seekVersion: get().seekVersion + 1,
        playing: false,
      });
    },
  };
}
