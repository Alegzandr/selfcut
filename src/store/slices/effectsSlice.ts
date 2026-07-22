import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import type { Clip, MediaAsset } from '../../types';
import { clipDurationMs, clipEndMs } from '../../model';
import { findClip, linkedPartnerIds } from '../projectOps';
import { EFFECTS_BY_ID } from '../../effects/catalog';
import { audioTarget, resolveEffectTargets } from '../../effects/apply';
import { presetPatch } from '../../effects/presetApply';
import { DEFAULT_CROSSFADE_MS, MIN_CLIP_DURATION_MS } from '../../app/config';

/** The clip immediately before `clip` on its track, or null when it is the first. */
function previousClip(clips: Clip[], clip: Clip): Clip | null {
  let best: Clip | null = null;
  for (const c of clips) {
    if (c.id === clip.id || c.timelineStartMs > clip.timelineStartMs) continue;
    if (!best || c.timelineStartMs > best.timelineStartMs) {
      best = c;
    } else if (c.timelineStartMs === best.timelineStartMs && clipEndMs(c) > clipEndMs(best)) {
      // Of two clips starting together, the one running longest is the one this
      // clip actually emerges from.
      best = c;
    }
  }
  return best;
}

/**
 * Whether a clip paints picture, for preset targeting.
 *
 * Not `catalog.ts`'s `paintsPicture`: that one requires a backing asset, which
 * the generated clips (text, solid, shape) do not have - yet they very much
 * paint, and the inspector already offers them a Transform section.
 */
function paintsPicture(clip: Clip, asset: MediaAsset | undefined): boolean {
  return clip.kind === 'media' ? !!asset && asset.kind !== 'audio' : true;
}

export function createEffectsSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory }: SliceHelpers,
): Pick<EditorState, 'applyEffectPreset' | 'applyTransition' | 'applyClipPreset'> {
  return {
    applyClipPreset: (look, clipIds) => {
      const { project, assets } = get();
      // Merged per target id: the audio half of a preset redirects onto a linked
      // partner, so one selected clip can produce patches for two.
      const patches = new Map<string, Partial<Clip>>();
      let truncated = false;

      for (const clipId of clipIds) {
        const found = findClip(project, clipId);
        if (!found) continue;
        const clip = found.clip;
        const sound = audioTarget(project, clip);

        // Picture and sound are patched separately because they may land on
        // different clips; each half is asked for on the clip that can take it.
        const picture = presetPatch(look, clip, clipDurationMs(clip), {
          hasPicture: paintsPicture(clip, assets[clip.assetId]),
          hasAudio: false,
        });
        truncated ||= picture.truncated;
        if (Object.keys(picture.patch).length) {
          patches.set(clip.id, { ...patches.get(clip.id), ...picture.patch });
        }

        if (assets[sound.assetId]?.hasAudio) {
          const audio = presetPatch(look, sound, clipDurationMs(sound), {
            hasPicture: false,
            hasAudio: true,
          });
          if (Object.keys(audio.patch).length) {
            patches.set(sound.id, { ...patches.get(sound.id), ...audio.patch });
          }
        }
      }

      if (patches.size === 0) return { changed: [], truncated: false };

      withHistory((p) => {
        for (const [id, patch] of patches) {
          const found = findClip(p, id);
          if (found) Object.assign(found.clip, patch);
        }
      });
      // A box-selection can name keys the trimming just removed, and a stale ref
      // would then re-ease or delete whatever moved into its slot.
      set({ selectedKeyframes: [] });

      return { changed: [...patches.keys()], truncated };
    },

    applyEffectPreset: (effectId, clipIds) => {
      const preset = EFFECTS_BY_ID[effectId];
      if (!preset || clipIds.length === 0) return;
      const state = get();
      // Resolved against the live project: `accepts` needs the backing asset,
      // and an audio preset may redirect onto a linked partner.
      const targets = resolveEffectTargets(state.project, state.assets, effectId, clipIds);
      if (targets.length === 0) return;
      withHistory((p) => {
        for (const id of targets) {
          const found = findClip(p, id);
          if (found) Object.assign(found.clip, preset.patch(found.clip));
        }
      });
    },

    applyTransition: (clipId, type) => {
      const p = get().project;
      const found = findClip(p, clipId);
      if (!found) return false;
      const { clip, track } = found;
      const prev = previousClip(track.clips, clip);
      // Nothing to transition from: a style on the first clip of a track has no
      // overlap to render over, now or ever.
      if (!prev) return false;

      const overlap = clipEndMs(prev) - clip.timelineStartMs;
      if (overlap > 0) {
        // Already crossfading: only the style changes, the edit stays put.
        get().updateClipCommitted(clipId, { transition: type });
        return true;
      }
      // A deliberate gap is not a cut: closing it would move the clip an
      // arbitrary distance and silently retime the edit. Refuse instead.
      if (overlap < 0) return false;

      // Butt cut: slide this clip back over its predecessor to open the window
      // the transition renders in. Both clips must keep a minimum exposed body,
      // and the slide must not reach the clip two positions back (which
      // `resolveOverlaps` would then undo by shoving everything right).
      const prevPrev = previousClip(
        track.clips.filter((c) => c.id !== clip.id),
        prev,
      );
      const headroom = clip.timelineStartMs - (prevPrev ? clipEndMs(prevPrev) : 0);
      const window = Math.min(
        DEFAULT_CROSSFADE_MS,
        clipDurationMs(prev) - MIN_CLIP_DURATION_MS,
        clipDurationMs(clip) - MIN_CLIP_DURATION_MS,
        headroom,
      );
      if (window <= 0) return false;

      // Linked partners follow the same shift, or picture and sound desync.
      const partners = linkedPartnerIds(p, clipId);
      withHistory((draft) => {
        const target = findClip(draft, clipId);
        if (!target) return;
        target.clip.transition = type;
        target.clip.timelineStartMs = Math.max(0, target.clip.timelineStartMs - window);
        for (const pid of partners) {
          const partner = findClip(draft, pid);
          if (partner) {
            partner.clip.timelineStartMs = Math.max(0, partner.clip.timelineStartMs - window);
          }
        }
      }, clipId);
      return true;
    },
  };
}
