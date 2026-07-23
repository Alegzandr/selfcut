import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import type { Clip } from '../../types';
import type { ParsedCube } from '../../effects/lut';
import { patchClips } from '../projectOps';
import { uid } from '../../lib/id';

/**
 * LUT management: importing `.cube` tables into the project and wiring them onto
 * clips. LUTs live on `Project.luts` (see the type), so importing/removing is a
 * project edit and rides the same history + persistence + export-transfer paths
 * as everything else on the project.
 *
 * Intensity has a live setter (no history) so dragging its slider stays smooth;
 * the surrounding `beginGesture`/`endGesture` on the slider commits one undo
 * step for the whole drag, matching how the colour sliders already behave.
 */
export function createLutsSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<EditorState, 'importLut' | 'removeLut' | 'setClipsLut' | 'setClipLutIntensity' | 'clearClipLut'> {
  /** Merge a new `lut` field into a clip's colour without dropping its other grades. */
  const withLut = (lut: { id: string; intensity: number } | undefined) => (c: Clip): Clip => {
    const color = { ...c.color, lut };
    if (lut === undefined) delete color.lut;
    return { ...c, color } as Clip;
  };

  return {
    importLut: (name, parsed: ParsedCube) => {
      const id = uid('lut');
      withHistory((p) => {
        p.luts = [...(p.luts ?? []), { id, name, size: parsed.size, data: parsed.data }];
      });
      return id;
    },

    removeLut: (id) =>
      withHistory((p) => {
        p.luts = (p.luts ?? []).filter((l) => l.id !== id);
        // Strip the reference from every clip pointing at it, or those clips
        // would keep a dangling id (harmless at render time, but confusing in
        // the inspector, which would show a LUT that no longer exists).
        for (const track of p.tracks) {
          for (const clip of track.clips) {
            if (clip.color?.lut?.id === id) delete clip.color.lut;
          }
        }
      }),

    setClipsLut: (clipIds, lutId) =>
      withHistory((p) => {
        for (const track of p.tracks) {
          for (const clip of track.clips) {
            if (!clipIds.includes(clip.id)) continue;
            // Keep the current intensity when re-picking a LUT on a clip that
            // already had one, so swapping tables doesn't reset the strength.
            const intensity = clip.color?.lut?.intensity ?? 1;
            clip.color = { ...clip.color, lut: { id: lutId, intensity } };
          }
        }
      }),

    setClipLutIntensity: (clipId, intensity) =>
      set({
        project: patchClips(
          get().project,
          new Map([
            [
              clipId,
              (c: Clip): Clip => {
                const existing = c.color?.lut;
                if (!existing) return c;
                return withLut({ id: existing.id, intensity })(c);
              },
            ],
          ]),
        ),
      }),

    clearClipLut: (clipId) =>
      withHistory((p) => {
        for (const track of p.tracks) {
          for (const clip of track.clips) {
            if (clip.id === clipId && clip.color?.lut) delete clip.color.lut;
          }
        }
      }),
  };
}
