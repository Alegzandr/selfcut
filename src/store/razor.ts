import type { Clip, Project } from '../types';
import { clipDurationMs, cloneClip, sliceClipAnimation, sliceVelocity, timelineToSourceMs } from '../model';
import { uid } from '../lib/id';

/**
 * Razor one clip at a timeline instant, inside an Immer draft: `clip` becomes
 * the left half in place and the right half comes back for the caller to add
 * to the track. The one place the razor's rules live - keyframes clip-local
 * and rebased, the speed ramp cut on source offsets, fades dropped at the new
 * seam, a linked group re-keyed so the right halves pair with each other -
 * so the split command and paste-insert cannot razor differently.
 *
 * `relink` maps each group's old linkId to the one its right halves share;
 * pass the same map for every clip razored in one edit.
 */
export function razorClip(clip: Clip, atMs: number, relink: Map<string, string>): Clip {
  const splitSource = timelineToSourceMs(clip, atMs);
  // Keyframes are clip-local, so each half keeps only the stretch of
  // animation it actually covers - the right half rebased to its own start.
  // Copying the whole animation to both halves would make each one replay
  // the full move in its own, shorter span.
  const cut = atMs - clip.timelineStartMs;
  const durationMs = clipDurationMs(clip);
  const right: Clip = {
    ...sliceClipAnimation(cloneClip(clip), cut, durationMs),
    id: uid('clip'),
    timelineStartMs: atMs,
    sourceInMs: splitSource,
    fadeInMs: 0,
  };
  const left = sliceClipAnimation(cloneClip(clip), 0, cut);
  // The ramp is anchored to the source, so it is razored on source offsets
  // rather than on `cut`. `sliceVelocity` synthesizes the boundary key, so
  // neither half changes speed at the seam.
  if (clip.velocity?.length) {
    const span = clip.sourceOutMs - clip.sourceInMs;
    const at = splitSource - clip.sourceInMs;
    right.velocity = sliceVelocity(clip.velocity, at, span);
    clip.velocity = sliceVelocity(clip.velocity, 0, at);
  }
  if (left.animation) clip.animation = left.animation;
  if (left.color) clip.color = left.color;
  if (left.mask) clip.mask = left.mask;
  if (left.redactions) clip.redactions = left.redactions;
  if (clip.linkId) {
    let nextLink = relink.get(clip.linkId);
    if (!nextLink) {
      nextLink = uid('link');
      relink.set(clip.linkId, nextLink);
    }
    right.linkId = nextLink;
  }
  clip.sourceOutMs = splitSource;
  clip.fadeOutMs = 0;
  return right;
}

/**
 * Open `spanMs` of room at `atMs` on every unlocked track of a draft: clips
 * straddling the instant are razored there, then everything from it on slides
 * right. Every track, not just the ones receiving content - an insert that
 * moved one lane would slide a voice-over off its picture.
 */
export function insertRoom(p: Project, atMs: number, spanMs: number): void {
  const relink = new Map<string, string>();
  for (const track of p.tracks) {
    if (track.locked) continue;
    const additions: Clip[] = [];
    for (const clip of track.clips) {
      const end = clip.timelineStartMs + clipDurationMs(clip);
      if (clip.timelineStartMs < atMs && end > atMs) additions.push(razorClip(clip, atMs, relink));
    }
    track.clips.push(...additions);
    for (const clip of track.clips) {
      if (clip.timelineStartMs >= atMs) clip.timelineStartMs += spanMs;
    }
  }
}
