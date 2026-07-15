import { Clip, Project } from '../types';
import { clipEndMs, clipEnvelopeGainAt, isGeneratedClip, trackCrossfades } from '../model';

export interface ScheduledSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Every node of the clip chain (gain, mono downmix, panner) - disconnected on stop. */
  nodes: AudioNode[];
}

/** Where a track's clips connect: a plain node, or a per-track bus factory. */
export type MixDestination = AudioNode | ((trackId: string) => AudioNode);

/**
 * Schedule every audible clip of a project onto a Web Audio context.
 * Used by both the preview (AudioContext, fromMs = playhead) and
 * the export (OfflineAudioContext, fromMs = 0).
 */
export function scheduleProjectAudio(
  ctx: BaseAudioContext,
  destination: MixDestination,
  project: Project,
  getBuffer: (assetId: string, audioTrackIndex?: number) => AudioBuffer | null,
  fromMs: number,
  startAtCtxTime: number,
  rate = 1,
): ScheduledSource[] {
  const scheduled: ScheduledSource[] = [];

  for (const track of project.tracks) {
    if (track.muted) continue;
    const trackVolume = track.volume ?? 1;
    if (trackVolume <= 0) continue;
    const xfades = trackCrossfades(track.clips);
    const dest = typeof destination === 'function' ? destination(track.id) : destination;
    for (const clip of track.clips) {
      if (isGeneratedClip(clip)) continue;
      // The video side of an A/V link delegates its audio to the linked audio
      // clip; playing it here too would double the source.
      if (track.kind === 'video' && clip.linkId) continue;
      if (clip.volume <= 0) continue;
      if (clipEndMs(clip) <= fromMs) continue;
      const buffer = getBuffer(clip.assetId, clip.audioTrackIndex);
      if (!buffer) continue;
      const xf = xfades.get(clip.id) ?? { inMs: 0, outMs: 0 };
      scheduled.push(
        scheduleClip(ctx, dest, clip, buffer, fromMs, startAtCtxTime, rate, trackVolume, xf.inMs, xf.outMs),
      );
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
  rate: number,
  trackVolume: number,
  xfadeInMs: number,
  xfadeOutMs: number,
): ScheduledSource {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // Shuttle (J/L): the global rate compounds with the clip's own speed.
  source.playbackRate.value = clip.speed * rate;

  const gain = ctx.createGain();
  source.connect(gain);

  // Chain: gain (envelope) → mono downmix? → balance? → destination.
  const nodes: AudioNode[] = [gain];
  let tail: AudioNode = gain;
  if (clip.mono) {
    // A 1-channel explicit gain node averages L/R; the stereo destination
    // then feeds the same mono signal to both speakers.
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    tail.connect(mono);
    nodes.push(mono);
    tail = mono;
  }
  const pan = clip.pan ?? 0;
  if (pan !== 0) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    tail.connect(panner);
    nodes.push(panner);
    tail = panner;
  }
  tail.connect(destination);

  const clipStart = clip.timelineStartMs;
  const clipEnd = clipEndMs(clip);
  const tlToCtx = (tlMs: number) => startAtCtxTime + (tlMs - fromMs) / 1000 / rate;

  const startCtx = Math.max(startAtCtxTime, tlToCtx(clipStart));
  const offsetSourceMs = clip.sourceInMs + Math.max(0, fromMs - clipStart) * clip.speed;
  const remainingSourceSec = (clip.sourceOutMs - offsetSourceMs) / 1000;
  if (remainingSourceSec <= 0) {
    return { source, gain, nodes };
  }

  // Gain envelope: base volume × fades/crossfades (linear ramps). A crossfade
  // is an implicit fade of the overlap duration; the longer of the explicit
  // fade and the crossfade wins, keeping the ramp linear.
  const base = clip.volume * trackVolume;
  const envAt = (tlMs: number) => base * clipEnvelopeGainAt(clip, tlMs, xfadeInMs, xfadeOutMs);
  const effectiveStartTl = Math.max(fromMs, clipStart);
  gain.gain.setValueAtTime(envAt(effectiveStartTl), startCtx);

  const fadeIn = Math.max(clip.fadeInMs, xfadeInMs);
  const fadeOut = Math.max(clip.fadeOutMs, xfadeOutMs);
  const breakpoints: number[] = [];
  if (fadeIn > 0) breakpoints.push(clipStart + fadeIn);
  if (fadeOut > 0) breakpoints.push(clipEnd - fadeOut);
  breakpoints.push(clipEnd);
  for (const tl of breakpoints.sort((a, b) => a - b)) {
    if (tl <= effectiveStartTl) continue;
    gain.gain.linearRampToValueAtTime(envAt(tl), tlToCtx(tl));
  }

  source.start(startCtx, offsetSourceMs / 1000, remainingSourceSec);
  return { source, gain, nodes };
}

export function stopScheduled(scheduled: ScheduledSource[]): void {
  for (const { source, nodes } of scheduled) {
    try {
      source.stop();
    } catch {
      // never started / already stopped
    }
    source.disconnect();
    for (const node of nodes) node.disconnect();
  }
}
