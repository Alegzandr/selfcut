import { AudioFx, Clip, Project } from '../types';
import {
  clipEndMs,
  clipEnvelopeGainAt,
  delegatedLinkIds,
  isGeneratedClip,
  trackCrossfades,
} from '../model';
import { buildAudioFxChain } from './audioFx';

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
  const delegated = delegatedLinkIds(project);

  for (const track of project.tracks) {
    if (track.muted) continue;
    const trackVolume = track.volume ?? 1;
    if (trackVolume <= 0) continue;
    const xfades = trackCrossfades(track.clips);
    const dest = typeof destination === 'function' ? destination(track.id) : destination;
    for (const clip of track.clips) {
      if (isGeneratedClip(clip)) continue;
      // The video side of a link delegates its audio to the group's audio
      // clips; playing it here too would double the source. A group without any
      // audio-track member delegates nothing and stays audible.
      if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
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

  // Audio effects sit at the end of the clip chain (after gain/mono/pan), so
  // they process the clip's final signal before it reaches the mix bus.
  const fxChain = buildAudioFxChain(ctx, clip.audioFx);
  if (fxChain) {
    tail.connect(fxChain.input);
    fxChain.output.connect(destination);
    nodes.push(...fxChain.nodes);
  } else {
    tail.connect(destination);
  }

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

/**
 * Whether two project versions would schedule the exact same audio.
 *
 * The preview rebuilds its whole Web Audio graph whenever the project object
 * changes. Dragging, scaling or cropping a clip in the preview calls
 * `updateClip` on every pointermove, so during one drag that teardown ran ~60
 * times a second, each time re-anchoring playback 30 ms into the future - an
 * audible stutter for an edit that cannot affect the sound at all.
 *
 * Structural rather than a hash: the store is copy-on-write, so untouched
 * tracks and clips compare by identity and a one-clip edit costs one pass over
 * that clip's fields. Every field below is one that `scheduleProjectAudio` or
 * `scheduleClip` reads - if a new field starts driving the mix, it has to be
 * added here too, or the preview will stop following that edit.
 */
export function sameAudioMix(a: Project, b: Project): boolean {
  if (a === b) return true;
  if (a.tracks.length !== b.tracks.length) return false;
  for (let i = 0; i < a.tracks.length; i++) {
    const ta = a.tracks[i]!;
    const tb = b.tracks[i]!;
    if (ta === tb) continue;
    if (
      ta.id !== tb.id ||
      ta.kind !== tb.kind ||
      !!ta.muted !== !!tb.muted ||
      (ta.volume ?? 1) !== (tb.volume ?? 1) ||
      ta.clips.length !== tb.clips.length
    ) {
      return false;
    }
    for (let j = 0; j < ta.clips.length; j++) {
      const ca = ta.clips[j]!;
      const cb = tb.clips[j]!;
      if (ca === cb) continue;
      if (!sameAudioClip(ca, cb)) return false;
    }
  }
  return true;
}

function sameAudioClip(a: Clip, b: Clip): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.assetId === b.assetId &&
    a.audioTrackIndex === b.audioTrackIndex &&
    a.linkId === b.linkId &&
    a.volume === b.volume &&
    a.timelineStartMs === b.timelineStartMs &&
    a.sourceInMs === b.sourceInMs &&
    a.sourceOutMs === b.sourceOutMs &&
    a.speed === b.speed &&
    a.fadeInMs === b.fadeInMs &&
    a.fadeOutMs === b.fadeOutMs &&
    (a.pan ?? 0) === (b.pan ?? 0) &&
    !!a.mono === !!b.mono &&
    sameAudioFx(a.audioFx, b.audioFx)
  );
}

/** Whether two clips carry the same audio effects, in the same order and amounts. */
function sameAudioFx(a: AudioFx[] | undefined, b: AudioFx[] | undefined): boolean {
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    if (a![i]!.type !== b![i]!.type || a![i]!.amount !== b![i]!.amount) return false;
  }
  return true;
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
