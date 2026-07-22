import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { clamp } from '../../lib/time';
import {
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_TRACK_HEIGHT_PX,
  MAX_TRACK_HEIGHT_PX,
  MIN_TRACK_HEADER_WIDTH_PX,
  MAX_TRACK_HEADER_WIDTH_PX,
  MIN_LIBRARY_WIDTH_PX,
  MAX_LIBRARY_WIDTH_PX,
  MIN_INSPECTOR_WIDTH_PX,
  MAX_INSPECTOR_WIDTH_PX,
} from '../../app/config';
import { PREVIEW_VIEW_RESET, isViewReset } from '../../preview/view';
import {
  TIME_FORMAT_KEY,
  TRACK_HEIGHT_KEY,
  TRACK_HEADER_WIDTH_KEY,
  LIBRARY_WIDTH_KEY,
  INSPECTOR_WIDTH_KEY,
  PREVIEW_RESOLUTION_KEY,
  PREVIEW_VOLUME_KEY,
  PREVIEW_MUTED_KEY,
} from '../constants';

/** How many imported presets the session shelf holds before dropping the oldest. */
const MAX_LOADED_PRESETS = 24;

/** Session-unique ids for the shelf. Never persisted, so a counter is enough. */
let nextPresetSeq = 1;

/** Keys of the persisted pane-width fields - all three resize the same way. */
type WidthKey = 'trackHeaderWidthPx' | 'libraryWidthPx' | 'inspectorWidthPx';

/**
 * Build a pane-width setter: clamp, skip the no-op (these fire on every
 * pointermove of a drag, most of which land on the same rounded pixel), persist.
 */
function setWidth(
  set: StoreSet,
  get: StoreGet,
  field: WidthKey,
  storageKey: string,
  min: number,
  max: number,
): (px: number) => void {
  return (px) => {
    const next = Math.round(clamp(px, min, max));
    if (next === get()[field]) return;
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* private mode / no storage - the choice just won't persist */
    }
    set({ [field]: next } as Pick<EditorState, WidthKey>);
  };
}

export function createUiSlice(
  set: StoreSet,
  get: StoreGet,
  _helpers: SliceHelpers,
): Pick<
  EditorState,
  | 'toggleSnap'
  | 'setSnapGuide'
  | 'setDragBadge'
  | 'setPxPerSec'
  | 'setTrackHeightPx'
  | 'setTrackHeaderWidthPx'
  | 'setLibraryWidthPx'
  | 'setInspectorWidthPx'
  | 'setTimelinePadLeft'
  | 'setInspectorOpen'
  | 'setInspectorTab'
  | 'setLibraryOpen'
  | 'setLibraryTab'
  | 'setShortcutsOpen'
  | 'setPreferencesOpen'
  | 'setAboutOpen'
  | 'openContextMenu'
  | 'closeContextMenu'
  | 'requestConfirm'
  | 'resolveConfirm'
  | 'setRenamingMarker'
  | 'setTimeFormat'
  | 'setPreviewTool'
  | 'setPreviewShapeKind'
  | 'setPreviewView'
  | 'resetPreviewView'
  | 'setPreviewResolution'
  | 'setPreviewVolume'
  | 'togglePreviewMuted'
  | 'setExportOpen'
  | 'setError'
  | 'setNotice'
  | 'addLoadedPreset'
  | 'removeLoadedPreset'
> {
  return {
    addLoadedPreset: (name, look) => {
      const id = `preset-${nextPresetSeq++}`;
      // Newest first, and capped: the shelf is a convenience over the files on
      // disk, not a library the user is expected to curate.
      set({ loadedPresets: [{ id, name, look }, ...get().loadedPresets].slice(0, MAX_LOADED_PRESETS) });
    },

    removeLoadedPreset: (id) =>
      set({ loadedPresets: get().loadedPresets.filter((p) => p.id !== id) }),

    toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),

    setSnapGuide: (ms) => {
      if (get().snapGuideMs !== ms) set({ snapGuideMs: ms });
    },

    setDragBadge: (badge) => {
      const cur = get().dragBadge;
      if (cur?.clipId === badge?.clipId && cur?.text === badge?.text) return;
      set({ dragBadge: badge });
    },

    setPxPerSec: (v) => set({ pxPerSec: clamp(v, MIN_PX_PER_SEC, MAX_PX_PER_SEC) }),

    setTrackHeightPx: (px) => {
      const next = Math.round(clamp(px, MIN_TRACK_HEIGHT_PX, MAX_TRACK_HEIGHT_PX));
      if (next === get().trackHeightPx) return;
      try {
        localStorage.setItem(TRACK_HEIGHT_KEY, String(next));
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ trackHeightPx: next });
    },

    setTrackHeaderWidthPx: setWidth(
      set,
      get,
      'trackHeaderWidthPx',
      TRACK_HEADER_WIDTH_KEY,
      MIN_TRACK_HEADER_WIDTH_PX,
      MAX_TRACK_HEADER_WIDTH_PX,
    ),
    setLibraryWidthPx: setWidth(
      set,
      get,
      'libraryWidthPx',
      LIBRARY_WIDTH_KEY,
      MIN_LIBRARY_WIDTH_PX,
      MAX_LIBRARY_WIDTH_PX,
    ),
    setInspectorWidthPx: setWidth(
      set,
      get,
      'inspectorWidthPx',
      INSPECTOR_WIDTH_KEY,
      MIN_INSPECTOR_WIDTH_PX,
      MAX_INSPECTOR_WIDTH_PX,
    ),

    setTimelinePadLeft: (px) => {
      if (get().timelinePadLeft !== px) set({ timelinePadLeft: px });
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setInspectorTab: (tab) => set({ inspectorTab: tab }),
    setLibraryOpen: (open) => set({ libraryOpen: open }),
    setLibraryTab: (tab) => set({ libraryTab: tab }),
    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
    setPreferencesOpen: (open) => set({ preferencesOpen: open }),
    setAboutOpen: (open) => set({ aboutOpen: open }),

    openContextMenu: (x, y, target) => set({ contextMenu: { x, y, target } }),
    closeContextMenu: () => {
      if (get().contextMenu) set({ contextMenu: null });
    },
    setRenamingMarker: (markerId) => set({ renamingMarkerId: markerId }),

    requestConfirm: (options) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is up would strand the first caller's
        // promise forever: decline it so its `await` unblocks.
        get().confirmDialog?.resolve(false);
        set({ confirmDialog: { ...options, resolve } });
      }),
    resolveConfirm: (ok) => {
      const pending = get().confirmDialog;
      if (!pending) return;
      set({ confirmDialog: null });
      pending.resolve(ok);
    },

    setTimeFormat: (format) => {
      try {
        localStorage.setItem(TIME_FORMAT_KEY, format);
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ timeFormat: format });
    },

    setPreviewTool: (tool) => {
      if (get().previewTool !== tool) set({ previewTool: tool });
    },

    // Fires on every pointermove of a pan and every wheel notch, so it skips the
    // commit when nothing actually moved (clamped drags against an edge).
    setPreviewShapeKind: (kind) => {
      if (get().previewShapeKind !== kind) set({ previewShapeKind: kind });
    },

    setPreviewView: (view) => {
      const cur = get().previewView;
      if (cur.zoom === view.zoom && cur.x === view.x && cur.y === view.y) return;
      set({ previewView: view });
    },

    resetPreviewView: () => {
      if (!isViewReset(get().previewView)) set({ previewView: PREVIEW_VIEW_RESET });
    },

    setPreviewResolution: (mode) => {
      try {
        localStorage.setItem(PREVIEW_RESOLUTION_KEY, mode);
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ previewResolution: mode });
    },

    setPreviewVolume: (gain) => {
      const v = clamp(gain, 0, 1);
      try {
        localStorage.setItem(PREVIEW_VOLUME_KEY, String(v));
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ previewVolume: v });
    },

    togglePreviewMuted: () => {
      const muted = !get().previewMuted;
      try {
        localStorage.setItem(PREVIEW_MUTED_KEY, muted ? '1' : '0');
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ previewMuted: muted });
    },

    setExportOpen: (open) => set({ exportOpen: open }),
    // An error and a confirmation share one slot: raising either clears the
    // other, so the toast never contradicts itself.
    setError: (msg) => set({ error: msg, ...(msg ? { notice: null } : {}) }),
    setNotice: (msg) => set({ notice: msg, ...(msg ? { error: null } : {}) }),
  };
}
