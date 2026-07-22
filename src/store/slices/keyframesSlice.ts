/**
 * The keyframe box-selection and the batch edits that act on it: retime,
 * delete, re-ease. Kept apart from `clipsSlice` (which edits one clip's
 * animation at a time) because every operation here spans an arbitrary set of
 * `(clipId, prop, t)` triples — possibly across several clips and tracks.
 *
 * `t` is part of a keyframe's identity, so `moveSelectedKeyframes` rewrites the
 * selection as it retimes: without that, a drag would lose its own selection on
 * the first frame.
 */
import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { Channel, Clip, Keyframe, KeyframeProp, KeyframeRef } from '../../types';
import { clipDurationMs, keyframesOf, removeKeyframe, writeChannel } from '../../model';
import { findClip, patchClips } from '../projectOps';

/** Two keyframe times within this many ms are the same key (matches the model). */
const SAME_KEY_EPSILON_MS = 1;

/** Selected keys grouped by clip, then by property, as a set of times. */
function byClipAndProp(refs: KeyframeRef[]): Map<string, Map<KeyframeProp, number[]>> {
  const out = new Map<string, Map<KeyframeProp, number[]>>();
  for (const ref of refs) {
    let props = out.get(ref.clipId);
    if (!props) out.set(ref.clipId, (props = new Map()));
    const times = props.get(ref.prop);
    if (times) times.push(ref.t);
    else props.set(ref.prop, [ref.t]);
  }
  return out;
}

/** Whether `t` is one of the selected times on a property. */
function isSelected(times: number[], t: number): boolean {
  return times.some((sel) => Math.abs(sel - t) < SAME_KEY_EPSILON_MS);
}

export function createKeyframesSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<
  EditorState,
  | 'setSelectedKeyframes'
  | 'moveSelectedKeyframes'
  | 'deleteSelectedKeyframes'
  | 'setSelectedKeyframesEase'
> {
  /** Rewrite one clip's animation, property by property, over the selected keys. */
  const editClips = (
    groups: Map<string, Map<KeyframeProp, number[]>>,
    edit: (keys: Keyframe[], times: number[], clip: Clip) => Keyframe[],
  ) =>
    patchClips(
      get().project,
      new Map(
        [...groups].map(([clipId, props]) => [
          clipId,
          (c: Clip): Clip => {
            // Cloned up front: `writeChannel` mutates the clip it is handed, and
            // this path runs outside the immer draft.
            const next = { ...c } as Clip;
            let changed = false;
            for (const [prop, times] of props) {
              const keys = keyframesOf(next, prop);
              if (!keys) continue;
              writeChannel(next, prop, edit(keys, times, c));
              changed = true;
            }
            return changed ? next : c;
          },
        ]),
      ),
    );

  return {
    setSelectedKeyframes: (refs) => set({ selectedKeyframes: refs }),

    moveSelectedKeyframes: (deltaMs) => {
      const refs = get().selectedKeyframes;
      if (!refs.length || deltaMs === 0) return;
      const groups = byClipAndProp(refs);
      const project = editClips(groups, (keys, times, clip) => {
        const dur = clipDurationMs(clip);
        return keys
          .map((k) =>
            isSelected(times, k.t)
              ? { ...k, t: Math.max(0, Math.min(dur, k.t + deltaMs)) }
              : k,
          )
          .sort((a, b) => a.t - b.t);
      });
      // The selection follows the keys it named: re-derive every ref against the
      // same clamp the edit applied, so the next drag frame still finds them.
      const moved: KeyframeRef[] = refs.map((ref) => {
        const clip = findClip(project, ref.clipId)?.clip;
        const dur = clip ? clipDurationMs(clip) : Infinity;
        return { ...ref, t: Math.max(0, Math.min(dur, ref.t + deltaMs)) };
      });
      set({ project, selectedKeyframes: moved });
    },

    deleteSelectedKeyframes: () => {
      const refs = get().selectedKeyframes;
      if (!refs.length) return;
      const groups = byClipAndProp(refs);
      withHistory((p) => {
        for (const [clipId, props] of groups) {
          const clip = findClip(p, clipId)?.clip;
          if (!clip) continue;
          for (const [prop, times] of props) {
            let channel: Channel | undefined = keyframesOf(clip, prop);
            if (!channel) continue;
            // Removing the last key of a property collapses it back to a
            // constant; `removeKeyframe` signals that by returning that value,
            // and `writeChannel` knows where that constant has to be stored.
            for (const t of times) {
              channel = removeKeyframe(channel, t);
              if (!Array.isArray(channel)) break;
            }
            writeChannel(clip, prop, channel);
          }
        }
      });
      set({ selectedKeyframes: [] });
    },

    setSelectedKeyframesEase: (ease) => {
      const refs = get().selectedKeyframes;
      if (!refs.length) return;
      const groups = byClipAndProp(refs);
      withHistory((p) => {
        for (const [clipId, props] of groups) {
          const clip = findClip(p, clipId)?.clip;
          if (!clip) continue;
          for (const [prop, times] of props) {
            for (const k of keyframesOf(clip, prop) ?? []) {
              if (isSelected(times, k.t)) k.ease = ease;
            }
          }
        }
      });
    },
  };
}
