import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { clamp } from '../../lib/time';
import { MIN_PX_PER_SEC, MAX_PX_PER_SEC } from '../../app/config';
import { TIME_FORMAT_KEY, PREVIEW_RESOLUTION_KEY } from '../constants';

export function createUiSlice(
  set: StoreSet,
  get: StoreGet,
  _helpers: SliceHelpers,
): Pick<
  EditorState,
  | 'toggleSnap'
  | 'setPxPerSec'
  | 'setTimelinePadLeft'
  | 'setInspectorOpen'
  | 'setLibraryOpen'
  | 'setShortcutsOpen'
  | 'setPreferencesOpen'
  | 'setAboutOpen'
  | 'openContextMenu'
  | 'closeContextMenu'
  | 'setRenamingMarker'
  | 'setTimeFormat'
  | 'setPreviewResolution'
  | 'setExportOpen'
  | 'setError'
> {
  return {
    toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),

    setPxPerSec: (v) => set({ pxPerSec: clamp(v, MIN_PX_PER_SEC, MAX_PX_PER_SEC) }),

    setTimelinePadLeft: (px) => {
      if (get().timelinePadLeft !== px) set({ timelinePadLeft: px });
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setLibraryOpen: (open) => set({ libraryOpen: open }),
    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
    setPreferencesOpen: (open) => set({ preferencesOpen: open }),
    setAboutOpen: (open) => set({ aboutOpen: open }),

    openContextMenu: (x, y, target) => set({ contextMenu: { x, y, target } }),
    closeContextMenu: () => {
      if (get().contextMenu) set({ contextMenu: null });
    },
    setRenamingMarker: (markerId) => set({ renamingMarkerId: markerId }),

    setTimeFormat: (format) => {
      try {
        localStorage.setItem(TIME_FORMAT_KEY, format);
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ timeFormat: format });
    },

    setPreviewResolution: (mode) => {
      try {
        localStorage.setItem(PREVIEW_RESOLUTION_KEY, mode);
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ previewResolution: mode });
    },

    setExportOpen: (open) => set({ exportOpen: open }),
    setError: (msg) => set({ error: msg }),
  };
}
