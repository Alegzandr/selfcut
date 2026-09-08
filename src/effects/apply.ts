import type { Clip, MediaAsset, Project, Track } from '../types';
import { EFFECTS_BY_ID } from './catalog';

/**
 * The clip an audio effect should really land on. A linked video clip delegates
 * its sound to the audio clip on the lane below (it is silent in the mix), so
 * an effect dropped on the picture half has to follow the link or it would sit
 * on a muted node and do nothing audible. Mirrors the inspector's `audioClip`.
 */
export function audioTarget(p: Project, clip: Clip): Clip {
  if (!clip.linkId) return clip;
  for (const track of p.tracks) {
    if (track.kind !== 'audio') continue;
    const partner = track.clips.find((c) => c.linkId === clip.linkId && c.id !== clip.id);
    if (partner) return partner;
  }
  return clip;
}

/**
 * Which clips a preset would actually change, given a selection: the audio
 * redirect resolved and the clips the preset rejects dropped. Shared by the
 * store action and the library UI, so a tile is enabled exactly when applying
 * it would do something.
 */
export function resolveEffectTargets(
  p: Project,
  assets: Record<string, MediaAsset>,
  effectId: string,
  clipIds: string[],
): string[] {
  const preset = EFFECTS_BY_ID[effectId];
  if (!preset) return [];
  const seen = new Set<string>();
  for (const clipId of clipIds) {
    const source = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    if (!source) continue;
    const clip = preset.group === 'audio' ? audioTarget(p, source) : source;
    if (preset.accepts(clip, assets[clip.assetId])) seen.add(clip.id);
  }
  return [...seen];
}

/**
 * Whether a catalogue entry means anything dropped on a whole LANE.
 *
 * Two gates. The entry has to have a track form at all (`trackPatch`) - a
 * push-in is a clip's transform and a lane has none - and it has to match the
 * lane's kind: a grade needs a picture, and an effect chain needs sound.
 *
 * Audio effects are refused on a video lane rather than merely being useless
 * there: importing a file with sound lays its audio on an AUDIO lane and links
 * the two, so a video lane's bus carries nothing to process. A knob that is
 * dead in every ordinary project should not be offered.
 */
export function trackAcceptsEffect(track: Track, effectId: string): boolean {
  const preset = EFFECTS_BY_ID[effectId];
  if (!preset?.trackPatch) return false;
  return preset.group === 'audio' ? track.kind === 'audio' : track.kind === 'video';
}

/**
 * The patch a catalogue entry lays on a lane, or null when the lane refuses it
 * or when applying it would change nothing (re-dropping an effect the chain
 * already runs). Null is what the caller turns into "this did not apply",
 * rather than an undo step that undoes nothing.
 */
export function trackEffectPatch(track: Track, effectId: string): Partial<Track> | null {
  if (!trackAcceptsEffect(track, effectId)) return null;
  const patch = EFFECTS_BY_ID[effectId]!.trackPatch!(track);
  return Object.keys(patch).length > 0 ? patch : null;
}
