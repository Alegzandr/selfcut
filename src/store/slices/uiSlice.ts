import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { clamp } from '../../lib/time';
import {
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_TRACK_HEIGHT_PX,
  MAX_TRACK_HEIGHT_PX,
} from '../../app/config';
import { PREVIEW_VIEW_RESET, isViewReset } from '../../preview/view';
import {
  TIME_FORMAT_KEY,
  TRACK_HEIGHT_KEY,
  PREVIEW_RESOLUTION_KEY,
  PREVIEW_VOLUME_KEY,
  PREVIEW_MUTED_KEY,
} from '../constants';

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
  | 'setTimelinePadLeft'
  | 'setInspectorOpen'
  | 'setInspectorTab'
  | 'setLibraryOpen'
  | 'setShortcutsOpen'
  | 'setPreferencesOpen'
  | 'setAboutOpen'
  | 'openContextMenu'
  | 'closeContextMenu'
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
> {
  return {
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

    setTimelinePadLeft: (px) => {
      if (get().timelinePadLeft !== px) set({ timelinePadLeft: px });
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setInspectorTab: (tab) => set({ inspectorTab: tab }),
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
