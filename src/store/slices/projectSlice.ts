import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { MediaAsset } from '../../types';
import { createEmptyProject } from '../projectOps';
import { disposeAssetResources } from '../../media/mediaCache';

export function createProjectSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<EditorState, 'setAspectRatio' | 'hydrate' | 'resetProject'> {
  return {
    setAspectRatio: (a) => withHistory((p) => void (p.aspectRatio = a)),

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
      set({
        project: createEmptyProject(),
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
