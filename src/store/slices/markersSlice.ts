import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { uid } from '../../lib/id';
import { sortedMarkers } from '../../model';

export function createMarkersSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<EditorState, 'addMarkerAtPlayhead' | 'moveMarker' | 'renameMarker' | 'removeMarker' | 'setMarkerColor' | 'removeAllMarkers'> {
  return {
    addMarkerAtPlayhead: () => {
      const { currentTimeMs, project } = get();
      if (sortedMarkers(project).some((m) => Math.abs(m.timeMs - currentTimeMs) < 1)) return;
      withHistory((p) => {
        p.markers = [
          ...p.markers,
          { id: uid('marker'), timeMs: Math.max(0, currentTimeMs), label: '' },
        ];
      });
    },

    moveMarker: (markerId, timeMs) => {
      const p = get().project;
      const at = Math.max(0, timeMs);
      const markers = p.markers.map((m) => (m.id === markerId ? { ...m, timeMs: at } : m));
      set({ project: { ...p, markers } });
    },

    renameMarker: (markerId, label) =>
      withHistory((p) => {
        const marker = p.markers.find((m) => m.id === markerId);
        if (marker) marker.label = label;
      }),

    removeMarker: (markerId) =>
      withHistory((p) => {
        p.markers = p.markers.filter((m) => m.id !== markerId);
      }),

    setMarkerColor: (markerId, color) =>
      withHistory((p) => {
        const marker = p.markers.find((m) => m.id === markerId);
        if (marker) marker.color = color;
      }),

    removeAllMarkers: () => {
      if (get().project.markers.length === 0) return;
      withHistory((p) => {
        p.markers = [];
      });
    },
  };
}
