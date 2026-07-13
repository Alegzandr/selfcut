import { Clip, Project, clipEndMs, clipFadeGainAt } from '../types';

export interface ScheduledSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * Schedule every audible clip of a project onto a Web Audio context.
 * Used by both the preview (AudioContext, fromMs = playhead) and
 * the export (OfflineAudioContext, fromMs = 0).
 */
export function scheduleProjectAudio(
  ctx: BaseAudioContext,
  destination: AudioNode,
  project: Project,
  getBuffer: (assetId: string) => AudioBuffer | null,
  fromMs: number,
  startAtCtxTime: number,
): ScheduledSource[] {
  const scheduled: ScheduledSource[] = [];

  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.volume <= 0) continue;
      if (clipEndMs(clip) <= fromMs) continue;
      const buffer = getBuffer(clip.assetId);
      if (!buffer) continue;
      scheduled.push(scheduleClip(ctx, destination, clip, buffer, fromMs, startAtCtxTime));
    }
  }
  return scheduled;
}

function scheduleClip(
  ctx: BaseAudioContext,
  destination: AudioNode,
  clip: Clip,
  buffer: AudioBuffer,
  fromMs: number,
  startAtCtxTime: number,
): ScheduledSource {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = clip.speed;

  const gain = ctx.createGain();
  source.connect(gain);
  gain.connect(destination);

  const clipStart = clip.timelineStartMs;
  const clipEnd = clipEndMs(clip);
  const tlToCtx = (tlMs: number) => startAtCtxTime + (tlMs - fromMs) / 1000;

  const startCtx = Math.max(startAtCtxTime, tlToCtx(clipStart));
  const offsetSourceMs = clip.sourceInMs + Math.max(0, fromMs - clipStart) * clip.speed;
  const remainingSourceSec = (clip.sourceOutMs - offsetSourceMs) / 1000;
  if (remainingSourceSec <= 0) {
    return { source, gain };
  }

  // Gain envelope: base volume × fades (linear ramps).
  const effectiveStartTl = Math.max(fromMs, clipStart);
  gain.gain.setValueAtTime(clip.volume * clipFadeGainAt(clip, effectiveStartTl), startCtx);

  const breakpoints: number[] = [];
  if (clip.fadeInMs > 0) breakpoints.push(clipStart + clip.fadeInMs);
  if (clip.fadeOutMs > 0) breakpoints.push(clipEnd - clip.fadeOutMs);
  breakpoints.push(clipEnd);
  for (const tl of breakpoints.sort((a, b) => a - b)) {
    if (tl <= effectiveStartTl) continue;
    gain.gain.linearRampToValueAtTime(clip.volume * clipFadeGainAt(clip, tl), tlToCtx(tl));
  }

  source.start(startCtx, offsetSourceMs / 1000, remainingSourceSec);
  return { source, gain };
}

export function stopScheduled(scheduled: ScheduledSource[]): void {
  for (const { source, gain } of scheduled) {
    try {
      source.stop();
    } catch {
      // never started / already stopped
    }
    source.disconnect();
    gain.disconnect();
  }
}
