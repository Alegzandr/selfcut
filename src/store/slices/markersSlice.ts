import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { uid } from '../../lib/id';
import { sortedMarkers } from '../../model';

export function createMarkersSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory, cues, setCues, withCues }: SliceHelpers,
): Pick<EditorState, 'addMarkerAtPlayhead' | 'moveMarker' | 'renameMarker' | 'removeMarker' | 'setMarkerColor' | 'removeAllMarkers'> {
  return {
    addMarkerAtPlayhead: () => {
      const { currentTimeMs, project } = get();
      if (sortedMarkers(project).some((m) => Math.abs(m.timeMs - currentTimeMs) < 1)) return;
      withHistory((p) => {
        setCues(p, [
          ...cues(p),
          { id: uid('marker'), timeMs: Math.max(0, currentTimeMs), label: '' },
        ]);
      });
    },

    moveMarker: (markerId, timeMs) => {
      const p = get().project;
      const at = Math.max(0, timeMs);
      const markers = cues(p).map((m) => (m.id === markerId ? { ...m, timeMs: at } : m));
      set({ project: withCues(p, markers) });
    },

    renameMarker: (markerId, label) =>
      withHistory((p) => {
        const marker = cues(p).find((m) => m.id === markerId);
        if (marker) marker.label = label;
      }),

    removeMarker: (markerId) =>
      withHistory((p) => {
        setCues(p, cues(p).filter((m) => m.id !== markerId));
      }),

    setMarkerColor: (markerId, color) =>
      withHistory((p) => {
        const marker = cues(p).find((m) => m.id === markerId);
        if (marker) marker.color = color;
      }),

    removeAllMarkers: () => {
      if (cues(get().project).length === 0) return;
      withHistory((p) => {
        setCues(p, []);
      });
    },
  };
}
