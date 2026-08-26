import { AudioFx, Clip, Project } from '../types';
import {
  clipEndMs,
  clipEnvelopeGainAt,
  delegatedLinkIds,
  isGeneratedClip,
  trackCrossfades,
} from '../model';
import type { AudioSegment } from '../media/audioSegments';
import { buildAudioFxChain } from './audioFx';

/** Where a track's clips connect: a plain node, or a per-track bus factory. */
export type MixDestination = AudioNode | ((trackId: string) => AudioNode);

/**
 * What is decoded right now for a source range. Synchronous by design: this is
 * called from a rAF tick and from inside an offline render, neither of which
 * can await. A range with nothing decoded yet simply returns nothing, and the
 * scheduler picks the segments up on a later pass (see `extend`).
 */
export type SegmentLookup = (
  assetId: string,
  audioTrackIndex: number | undefined,
  fromMs: number,
  toMs: number,
) => AudioSegment[];

/** The per-clip node chain, built once and fed by every segment of that clip. */
interface ClipChain {
  /** Where segment sources connect: the clip's gain (envelope) node. */
  input: AudioNode;
  /** Every node of the chain (gain, mono downmix, panner, fx) - disconnected on stop. */
  nodes: AudioNode[];
  sources: Set<AudioBufferSourceNode>;
}

/**
 * Schedules a project's audio onto a Web Audio context, a window at a time.
 *
 * Audio is decoded in segments (see `audioSegments.ts`), so a clip is played by
 * a row of buffer sources rather than by one: the piece under the playhead, the
 * one after it, and so on as the playhead reaches them. That is what lets an
 * hour-long source play at all - the old single-buffer decode was 1.4 GB in one
 * allocation - and it is why scheduling is INCREMENTAL rather than one call.
 *
 * Two rules make the incremental version sound identical to the old one:
 *
 * 1. **One chain per clip, built once.** Volume, fades, pan, mono and the fx
 *    chain are the clip's, not a segment's. Rebuilding them per window would
 *    double the gain at every boundary and restart every reverb tail.
 * 2. **A segment is placed at most once per clip.** `extend` is called on every
 *    tick, with overlapping windows and with segments that arrive late; without
 *    that rule the same 30 s would be scheduled twice and play twice.
 *
 * Everything is anchored to one (timeline ms, context time) pair fixed at
 * construction, so a window scheduled ten seconds later still lands exactly
 * where the transport says it should - no drift, and no re-anchoring click.
 */
export class MixScheduler {
  private chains = new Map<string, ClipChain>();
  /** `${clipId}@${segmentIndex}` for every segment already scheduled. */
  private placed = new Set<string>();
  private stopped = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly destination: MixDestination,
    private readonly getSegments: SegmentLookup,
    /** Timeline position that `anchorCtxTime` corresponds to. */
    private readonly anchorMediaMs: number,
    private readonly anchorCtxTime: number,
    /** Shuttle rate: timeline advances this much faster than context time. */
    private readonly rate = 1,
  ) {}

  /** Context time at which a timeline instant is heard. */
  private tlToCtx(tlMs: number): number {
    return this.anchorCtxTime + (tlMs - this.anchorMediaMs) / 1000 / this.rate;
  }

  /**
   * Schedule everything audible in `[fromMs, untilMs)` that is not scheduled
   * yet. Idempotent: calling it again with the same or an overlapping window
   * adds only what is new, which is what makes it safe to call every tick.
   */
  extend(project: Project, fromMs: number, untilMs: number): void {
    if (this.stopped || !(untilMs > fromMs)) return;
    const delegated = delegatedLinkIds(project);

    for (const track of project.tracks) {
      if (track.muted) continue;
      const trackVolume = track.volume ?? 1;
      if (trackVolume <= 0) continue;
      const xfades = trackCrossfades(track.clips);
      const dest = typeof this.destination === 'function' ? this.destination(track.id) : this.destination;
      for (const clip of track.clips) {
        if (isGeneratedClip(clip)) continue;
        // The video side of a link delegates its audio to the group's audio
        // clips; playing it here too would double the source. A group without
        // any audio-track member delegates nothing and stays audible.
        if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
        if (clip.volume <= 0) continue;
        if (clipEndMs(clip) <= fromMs || clip.timelineStartMs >= untilMs) continue;
        const xf = xfades.get(clip.id) ?? { inMs: 0, outMs: 0 };
        this.extendClip(clip, dest, trackVolume, xf.inMs, xf.outMs, fromMs, untilMs);
      }
    }
  }

  /** Stop and release every node this scheduler created. */
  stop(): void {
    this.stopped = true;
    for (const chain of this.chains.values()) {
      for (const source of chain.sources) {
        try {
          source.stop();
        } catch {
          // never started / already stopped
        }
        source.onended = null;
        source.disconnect();
      }
      chain.sources.clear();
      for (const node of chain.nodes) node.disconnect();
    }
    this.chains.clear();
    this.placed.clear();
  }

  private extendClip(
    clip: Clip,
    destination: AudioNode,
    trackVolume: number,
    xfadeInMs: number,
    xfadeOutMs: number,
    fromMs: number,
    untilMs: number,
  ): void {
    const clipStart = clip.timelineStartMs;
    const speed = clip.speed || 1;
    // Source range this window asks for. The clip's own in/out points bound it:
    // a window may reach past the end of the clip, and a segment must never be
    // played beyond what the trim admits.
    const windowFrom = Math.max(fromMs, clipStart);
    const windowTo = Math.min(untilMs, clipEndMs(clip));
    if (windowTo <= windowFrom) return;
    const srcFrom = clip.sourceInMs + (windowFrom - clipStart) * speed;
    const srcTo = Math.min(clip.sourceOutMs, clip.sourceInMs + (windowTo - clipStart) * speed);
    if (srcTo <= srcFrom) return;

    const segments = this.getSegments(clip.assetId, clip.audioTrackIndex, srcFrom, srcTo);
    if (segments.length === 0) return;

    // Built on first contact with the clip, so a clip whose audio has not been
    // decoded yet does not leave an idle chain hanging off the bus.
    const chain = this.chainFor(clip, destination, trackVolume, xfadeInMs, xfadeOutMs, windowFrom);
    const now = this.ctx.currentTime;

    for (const segment of segments) {
      const placedKey = `${clip.id}@${segment.index}`;
      if (this.placed.has(placedKey)) continue;

      // The whole overlap of this segment with the clip's trim, not just with
      // the window: the segment is scheduled once, so it has to carry all of
      // what the clip reads from it.
      const segmentEndMs = segment.startMs + (segment.buffer.length / segment.buffer.sampleRate) * 1000;
      const partFrom = Math.max(clip.sourceInMs, segment.startMs);
      const partTo = Math.min(clip.sourceOutMs, segmentEndMs);
      if (partTo <= partFrom) continue;

      let offsetSec = (partFrom - segment.startMs) / 1000;
      let durationSec = (partTo - partFrom) / 1000;
      let startCtx = this.tlToCtx(clipStart + (partFrom - clip.sourceInMs) / speed);
      // Behind the transport: the window started mid-segment (a seek, a loop
      // wrap), or this segment finished decoding after its moment had passed.
      // Enter it where it is now rather than replaying what has been heard.
      if (startCtx < now) {
        // Context seconds late × rate is timeline ms late; × speed is source.
        const skipSec = (now - startCtx) * this.rate * speed;
        if (skipSec >= durationSec) {
          // Entirely in the past. Marked placed all the same: re-deciding this
          // on every tick for the rest of a long clip is pure overhead.
          this.placed.add(placedKey);
          continue;
        }
        offsetSec += skipSec;
        durationSec -= skipSec;
        startCtx = now;
      }

      const source = this.ctx.createBufferSource();
      source.buffer = segment.buffer;
      // Shuttle (J/L): the global rate compounds with the clip's own speed.
      source.playbackRate.value = speed * this.rate;
      source.connect(chain.input);
      source.onended = () => {
        chain.sources.delete(source);
        source.disconnect();
      };
      chain.sources.add(source);
      source.start(startCtx, offsetSec, durationSec);
      this.placed.add(placedKey);
    }
  }

  /**
   * The clip's node chain and its gain envelope, created once.
   *
   * `effectiveStartTl` is where the clip is first heard in this session of
   * scheduling - the later of its start and the window that reached it - and is
   * what the envelope's opening value is read at. Fades and crossfades are then
   * linear ramps to their absolute timeline instants, so they land in the same
   * place whether the clip was reached by playing into it or by seeking on top
   * of it.
   */
  private chainFor(
    clip: Clip,
    destination: AudioNode,
    trackVolume: number,
    xfadeInMs: number,
    xfadeOutMs: number,
    effectiveStartTl: number,
  ): ClipChain {
    const existing = this.chains.get(clip.id);
    if (existing) return existing;

    const gain = this.ctx.createGain();
    const nodes: AudioNode[] = [gain];
    let tail: AudioNode = gain;

    if (clip.mono) {
      // A 1-channel explicit gain node averages L/R; the stereo destination
      // then feeds the same mono signal to both speakers.
      const mono = this.ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      tail.connect(mono);
      nodes.push(mono);
      tail = mono;
    }
    const pan = clip.pan ?? 0;
    if (pan !== 0) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      tail.connect(panner);
      nodes.push(panner);
      tail = panner;
    }
    // Audio effects sit at the end of the clip chain (after gain/mono/pan), so
    // they process the clip's final signal before it reaches the mix bus.
    const fxChain = buildAudioFxChain(this.ctx, clip.audioFx);
    if (fxChain) {
      tail.connect(fxChain.input);
      fxChain.output.connect(destination);
      nodes.push(...fxChain.nodes);
    } else {
      tail.connect(destination);
    }

    // Gain envelope: base volume × fades/crossfades (linear ramps). A crossfade
    // is an implicit fade of the overlap duration; the longer of the explicit
    // fade and the crossfade wins, keeping the ramp linear.
    const base = clip.volume * trackVolume;
    const envAt = (tlMs: number) => base * clipEnvelopeGainAt(clip, tlMs, xfadeInMs, xfadeOutMs);
    const clipEnd = clipEndMs(clip);
    gain.gain.setValueAtTime(
      envAt(effectiveStartTl),
      Math.max(this.ctx.currentTime, this.tlToCtx(effectiveStartTl)),
    );
    const fadeIn = Math.max(clip.fadeInMs, xfadeInMs);
    const fadeOut = Math.max(clip.fadeOutMs, xfadeOutMs);
    const breakpoints: number[] = [];
    if (fadeIn > 0) breakpoints.push(clip.timelineStartMs + fadeIn);
    if (fadeOut > 0) breakpoints.push(clipEnd - fadeOut);
    breakpoints.push(clipEnd);
    for (const tl of breakpoints.sort((a, b) => a - b)) {
      if (tl <= effectiveStartTl) continue;
      gain.gain.linearRampToValueAtTime(envAt(tl), this.tlToCtx(tl));
    }

    const chain: ClipChain = { input: gain, nodes, sources: new Set() };
    this.chains.set(clip.id, chain);
    return chain;
  }
}

/**
 * Schedule a whole span of a project in one call.
 *
 * What the export uses: it renders a slice at a time into an
 * `OfflineAudioContext`, where nothing arrives late and there is no next
 * window - so the incremental machinery above collapses into one `extend`.
 * The preview drives the scheduler directly instead (see `PlaybackEngine`).
 */
export function scheduleProjectAudio(
  ctx: BaseAudioContext,
  destination: MixDestination,
  project: Project,
  getSegments: SegmentLookup,
  fromMs: number,
  startAtCtxTime: number,
  durationMs: number,
  rate = 1,
): MixScheduler {
  const scheduler = new MixScheduler(ctx, destination, getSegments, fromMs, startAtCtxTime, rate);
  scheduler.extend(project, fromMs, fromMs + durationMs);
  return scheduler;
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
