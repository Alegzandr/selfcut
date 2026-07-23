import type { AnimatableProp, Channel, Clip, ClipAnimation, ClipColor, Keyframe } from '../types';
import { DEFAULT_TRANSFORM } from '../model';
import type { PresetLook } from './presetFile';

/**
 * Laying a `.sfx` preset onto a clip.
 *
 * Two rules carry the whole module.
 *
 * *Times are absolute.* A keyframe authored at 1500 ms lands at 1500 ms, on a
 * clip of any length. Keys past the target's end are trimmed here rather than
 * left to rot: the store and the lane renderer both address a keyframe by its
 * time, and one sitting beyond the clip is unreachable - undeletable from the
 * timeline, invisible in the inspector, yet still in the file.
 *
 * *Sections replace, they do not merge.* A section the preset carries overwrites
 * the target's; a section it omits leaves the target untouched. This is what an
 * After Effects animation preset does, and merging instead would produce a grade
 * that is half one look and half another - a result neither look's author ever
 * saw.
 */

/** Two keyframe times within this many ms are the same key. Matches `animation.ts`. */
const EPSILON_MS = 1;

/** What a target clip can take. */
export interface PresetTargetCaps {
  /** The clip paints picture: colour, transform, animation and zoom may land. */
  hasPicture: boolean;
  /** The clip carries sound: the audio chain may land. */
  hasAudio: boolean;
}

export interface PresetPatchResult {
  patch: Partial<Clip>;
  /** At least one keyframe fell past the clip's end and was trimmed or collapsed. */
  truncated: boolean;
  /** The preset carried a section this clip cannot take. */
  skippedPicture: boolean;
  skippedAudio: boolean;
}

/**
 * The keys of `keys` that survive a clip of `durationMs`, clamped into range and
 * de-duplicated. Returns null when nothing survives.
 *
 * A key sitting exactly on `durationMs` is kept: it is the clip's last instant,
 * which is inside the clip, and `sampleChannel` holds at the final key for
 * anything beyond it - so keeping it is both correct and free.
 */
function trimKeys(keys: Keyframe[], durationMs: number): Keyframe[] | null {
  const kept: Keyframe[] = [];
  for (const k of keys) {
    if (k.t > durationMs + EPSILON_MS) break; // sorted, so nothing after this fits either
    const t = Math.max(0, Math.min(durationMs, k.t));
    // Clamping can land two keys on the same time; the first one wins. Clamping
    // is monotonic, so the list is still sorted afterwards.
    const prev = kept[kept.length - 1];
    if (prev && Math.abs(prev.t - t) < EPSILON_MS) continue;
    kept.push({ ...k, t });
  }
  return kept.length ? kept : null;
}

/**
 * A channel trimmed to a clip. Collapses to a constant when no key survives:
 * with every key beyond the clip's end, `sampleChannel` would hold at the first
 * key for the clip's entire life, so the constant renders pixel-identically and
 * costs nothing to store.
 */
export function truncateChannel(ch: Channel, durationMs: number): Channel {
  if (!Array.isArray(ch)) return ch;
  if (!ch.length) return 0;
  const kept = trimKeys(ch, durationMs);
  return kept ?? ch[0]!.value;
}

/** Whether a channel lost anything to the clip's end. */
function channelTruncated(ch: Channel, durationMs: number): boolean {
  if (!Array.isArray(ch)) return false;
  const kept = trimKeys(ch, durationMs);
  return kept === null || kept.length !== ch.length;
}

function truncateColor(
  color: ClipColor,
  durationMs: number,
): { color: ClipColor; truncated: boolean } {
  const out: ClipColor = {};
  let truncated = false;
  for (const [key, value] of Object.entries(color)) {
    // `lut` is a reference, not a time-based channel: it carries through a
    // preset unchanged, with nothing to trim against the clip's length.
    if (key === 'lut') {
      out.lut = color.lut;
      continue;
    }
    const ch = value as Channel;
    if (channelTruncated(ch, durationMs)) truncated = true;
    (out as Record<string, Channel>)[key] = truncateChannel(ch, durationMs);
  }
  return { color: out, truncated };
}

/**
 * The patch a preset lays on one clip. `durationMs` is the target's clip-local
 * length, which is what keyframe times are trimmed against.
 */
export function presetPatch(
  look: PresetLook,
  clip: Clip,
  durationMs: number,
  caps: PresetTargetCaps,
): PresetPatchResult {
  const patch: Partial<Clip> = {};
  let truncated = false;

  const hasPictureSection = !!(look.color || look.transform || look.animation || look.zoomEnd);
  const skippedPicture = hasPictureSection && !caps.hasPicture;
  const skippedAudio = !!look.audioFx && !caps.hasAudio;

  if (caps.hasPicture) {
    if (look.color) {
      const r = truncateColor(look.color, durationMs);
      patch.color = r.color;
      truncated ||= r.truncated;
    }

    // The animation is folded first: a property whose keys all fall past the end
    // collapses to a constant, and for x/y/scale/rotation that constant has to
    // land in the transform this patch is about to write.
    const animation: ClipAnimation = {};
    const collapsed: Partial<Record<Exclude<AnimatableProp, 'opacity'>, number>> = {};
    if (look.animation) {
      for (const [key, keys] of Object.entries(look.animation) as [AnimatableProp, Keyframe[]][]) {
        const kept = trimKeys(keys, durationMs);
        if (kept && kept.length === keys.length) {
          animation[key] = kept;
          continue;
        }
        truncated = true;
        if (kept) {
          animation[key] = kept;
        } else if (key === 'opacity') {
          // Opacity has no static counterpart, so it stays animated - one key at
          // the clip's start holds the value for its whole length.
          animation[key] = [{ t: 0, value: keys[0]!.value }];
        } else {
          collapsed[key] = keys[0]!.value;
        }
      }
    }
    if (Object.keys(animation).length) patch.animation = animation;
    else if (look.animation) patch.animation = undefined;

    if (look.transform || Object.keys(collapsed).length) {
      // The target keeps its own crop: it frames this clip's source, and the
      // preset knows nothing about that footage.
      patch.transform = {
        ...(clip.transform ?? DEFAULT_TRANSFORM),
        ...(look.transform ?? {}),
        ...collapsed,
      };
    }

    if (look.zoomEnd !== undefined) patch.zoomEnd = look.zoomEnd;
  }

  // The whole chain, not an append: adding to what is there would stack a second
  // reverb on a clip that already had one, and the preset's order is the intent.
  if (caps.hasAudio && look.audioFx) patch.audioFx = look.audioFx.map((fx) => ({ ...fx }));

  return { patch, truncated, skippedPicture, skippedAudio };
}
