import { AudioFx, Clip, CompClip, Project, Track } from '../types';
import {
  clipEndMs,
  clipEnvelopeGainAt,
  cloneClip,
  type CompId,
  delegatedLinkIds,
  findComp,
  hasVelocity,
  isCompClip,
  isGeneratedClip,
  isTrackAudible,
  MAX_COMP_DEPTH,
  trackCrossfades,
  tracksOf,
} from '../model';
import { MIN_CLIP_DURATION_MS } from '../app/config';
import type { AudioSegment } from '../media/audioSegments';
import { buildAudioFxChain, type AudioFxChain } from './audioFx';

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

/**
 * How a nested composition's own timeline maps onto the ROOT one being played.
 *
 * The map is affine at every level (`rootMs = offsetMs + compMs * scale`), so
 * nesting composes into one more affine map rather than into a stack of them:
 * a clip three precomps deep is scheduled by projecting it into root time once
 * and then handing it to exactly the code that schedules a clip on the timeline.
 *
 * `prefix` keeps ids unique. A composition used twice plays the same clips at
 * two different instants, and every chain and every "already placed" mark is
 * keyed by clip id - without a per-instance prefix the second use would find
 * the first one's chain and schedule nothing.
 *
 * `destination` is the comp clip's own gain node, so the composition's whole
 * sound passes through the fades, volume, pan and effects applied to the clip
 * that plays it. `visFrom`/`visTo` are its extent in root ms: nothing outside
 * the window the comp clip actually plays may be heard.
 */
interface CompFrame {
  offsetMs: number;
  scale: number;
  prefix: string;
  destination: AudioNode;
  visFromMs: number;
  visToMs: number;
  depth: number;
}

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
  /**
   * The FX chain of each lane that has one, by track id, built on first use.
   *
   * One per track, not one per clip: a track effect processes the SUM of the
   * lane, which is the whole reason to reach for it. Building it per clip would
   * be five compressors that each only hear their own shot - they would pump
   * against each other at every cut - and five reverb tails restarting there.
   */
  private trackFx = new Map<string, AudioFxChain>();
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
  extend(project: Project, fromMs: number, untilMs: number, compId: CompId = null): void {
    if (this.stopped || !(untilMs > fromMs)) return;
    this.extendTracks(project, tracksOf(project, compId), fromMs, untilMs, null);
  }

  /**
   * Schedule one stack of lanes, either the timeline itself (`frame` null) or a
   * composition nested inside it.
   *
   * Solo, mute and link delegation are resolved against THESE lanes: a lane
   * soloed inside a precomp silences its neighbours in there and nothing else,
   * which is the only reading that lets a precomp be worked on without the
   * parent's mix changing under it.
   */
  private extendTracks(
    project: Project,
    tracks: Track[],
    fromMs: number,
    untilMs: number,
    frame: CompFrame | null,
  ): void {
    if (this.stopped || !(untilMs > fromMs)) return;
    const delegated = delegatedLinkIds(tracks);

    for (const track of tracks) {
      if (!isTrackAudible(track, tracks)) continue;
      const trackVolume = track.volume ?? 1;
      if (trackVolume <= 0) continue;
      const xfades = trackCrossfades(track.clips);
      // Inside a composition every lane feeds the comp clip's own chain, so the
      // group is faded, panned and metered as the one layer the parent sees.
      const bus = frame
        ? frame.destination
        : typeof this.destination === 'function'
          ? this.destination(track.id)
          : this.destination;
      const dest = this.trackInput(track, bus, frame?.prefix ?? '');
      for (const clip of track.clips) {
        if (clip.volume <= 0) continue;
        if (isCompClip(clip)) {
          this.extendComp(project, clip, dest, trackVolume, fromMs, untilMs, frame);
          continue;
        }
        if (isGeneratedClip(clip)) continue;
        // The video side of a link delegates its audio to the group's audio
        // clips; playing it here too would double the source. A group without
        // any audio-track member delegates nothing and stays audible.
        if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
        const scheduled = frame ? projectClip(clip, frame) : clip;
        if (!scheduled) continue;
        if (clipEndMs(scheduled) <= fromMs || scheduled.timelineStartMs >= untilMs) continue;
        const scale = frame ? frame.scale : 1;
        const xf = xfades.get(clip.id) ?? { inMs: 0, outMs: 0 };
        this.extendClip(
          scheduled,
          dest,
          trackVolume,
          xf.inMs * scale,
          xf.outMs * scale,
          fromMs,
          untilMs,
        );
      }
    }
  }

  /**
   * Schedule the composition a comp clip plays, through the clip's own chain.
   *
   * The clip is projected into root time first, exactly like a media clip, and
   * given a chain of its own - so its volume, fades, pan, mono and effects
   * process the composition's whole sound rather than any one layer of it. Its
   * extent becomes the window nothing inside may be heard outside of.
   *
   * A velocity ramp mutes it, for the same reason it mutes a media clip: a
   * buffer source plays at one rate for its whole life, and nothing here can
   * make a whole composition swoop in pitch.
   */
  private extendComp(
    project: Project,
    clip: CompClip,
    destination: AudioNode,
    trackVolume: number,
    fromMs: number,
    untilMs: number,
    frame: CompFrame | null,
  ): void {
    if (hasVelocity(clip)) return;
    const depth = (frame?.depth ?? 0) + 1;
    if (depth > MAX_COMP_DEPTH) return;
    const comp = findComp(project, clip.compId);
    if (!comp || comp.tracks.length === 0) return;
    const scheduled = frame ? projectClip(clip, frame) : clip;
    if (!scheduled) return;
    const startMs = scheduled.timelineStartMs;
    const endMs = clipEndMs(scheduled);
    if (endMs <= fromMs || startMs >= untilMs) return;

    const prefix = `${frame?.prefix ?? ''}${clip.id}/`;
    const chain = this.chainFor(scheduled, destination, trackVolume, 0, 0, Math.max(fromMs, startMs));
    // Composition ms -> root ms. `scheduled.speed` is already source (here:
    // composition) ms per ROOT ms, so its reciprocal is the scale, and the
    // origin is where composition time 0 would fall.
    const scale = 1 / (scheduled.speed || 1);
    this.extendTracks(project, comp.tracks, Math.max(fromMs, startMs), Math.min(untilMs, endMs), {
      offsetMs: startMs - scheduled.sourceInMs * scale,
      scale,
      prefix,
      destination: chain.input,
      visFromMs: startMs,
      visToMs: endMs,
      depth,
    });
  }

  /**
   * Where a lane's clips connect: its own FX chain when it carries one, spliced
   * once between every clip of the lane and the mix bus it feeds, else the bus
   * itself.
   *
   * The chain sits BEFORE the bus, so the track meter and the master gain both
   * read the processed lane - what the export will contain - rather than the
   * raw sum with the effect hanging off the side.
   */
  private trackInput(track: Track, bus: AudioNode, prefix: string): AudioNode {
    // Keyed with the composition instance, not by track id alone: one
    // composition used twice is two lanes feeding two different comp chains,
    // and sharing one effect chain between them would route the second use into
    // the first one's fader.
    const key = `${prefix}${track.id}`;
    const built = this.trackFx.get(key);
    if (built) return built.input;
    const chain = buildAudioFxChain(this.ctx, track.audioFx);
    if (!chain) return bus;
    chain.output.connect(bus);
    this.trackFx.set(key, chain);
    return chain.input;
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
    // The lane chains outlive every clip chain that fed them, so they are torn
    // down after: a track reverb left connected would keep ringing into a bus
    // the next schedule reuses.
    for (const chain of this.trackFx.values()) {
      for (const node of chain.nodes) node.disconnect();
    }
    this.trackFx.clear();
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
    // A velocity ramp silences the clip, in the preview and in the export
    // alike. A buffer source plays at one rate for its whole life, and a
    // varying rate would have to swoop the pitch with it - which is not sound
    // anyone wants under a speed ramp. Muting is the honest answer, and the
    // speed control says so at the moment the ramp is laid down rather than
    // leaving it to be discovered.
    if (hasVelocity(clip)) return;
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
 * A clip from inside a composition, rewritten as a clip on the ROOT timeline.
 *
 * Everything the scheduler needs is affine in time, so one projection is enough:
 * the start moves, the rate becomes source ms per ROOT ms, and the fades stretch
 * with the same factor. The trim is then cut back to the window the comp clip
 * actually plays, because the scheduler places a segment ONCE and reads the
 * clip's own in/out points to decide how much of it to play - a clip left
 * sticking out of the window would be heard past the end of the layer.
 *
 * Returns null for a clip the comp clip never reaches, and for a ramped one: a
 * velocity ramp is silent everywhere else too.
 */
function projectClip<T extends Clip>(clip: T, frame: CompFrame): T | null {
  if (hasVelocity(clip)) return null;
  const rawStart = frame.offsetMs + clip.timelineStartMs * frame.scale;
  const rawEnd = frame.offsetMs + clipEndMs(clip) * frame.scale;
  const start = Math.max(rawStart, frame.visFromMs);
  const end = Math.min(rawEnd, frame.visToMs);
  if (end - start < MIN_CLIP_DURATION_MS) return null;

  const out = cloneClip(clip);
  out.id = `${frame.prefix}${clip.id}`;
  // Source ms per ROOT ms: the clip's own rate against its composition, divided
  // by how much slower (or faster) that composition itself runs.
  out.speed = clip.speed / frame.scale;
  out.sourceInMs = clip.sourceInMs + (start - rawStart) * out.speed;
  out.sourceOutMs = clip.sourceOutMs - (rawEnd - end) * out.speed;
  out.timelineStartMs = start;
  out.fadeInMs = clip.fadeInMs * frame.scale;
  out.fadeOutMs = clip.fadeOutMs * frame.scale;
  return out;
}

/**
 * Every clip that can be HEARD in `[fromMs, untilMs)`, projected onto the root
 * timeline - nested compositions flattened out, each clip carrying the start,
 * trim and rate it plays at from where the listener stands.
 *
 * The export uses it to decide what to decode and whether there is any sound at
 * all. It applies exactly the rules `extendTracks` above schedules by (mute,
 * solo, lane and clip gain, link delegation, ramped clips silenced), because a
 * clip the mix will play and this misses is a slice of the file that comes out
 * silent - and one it lists and the mix skips is a silent AAC track forced into
 * a file that should have had none. Change one, change the other.
 */
export function flattenAudibleClips(
  project: Project,
  fromMs: number,
  untilMs: number,
  compId: CompId = null,
): Clip[] {
  const out: Clip[] = [];
  collectAudible(project, tracksOf(project, compId), fromMs, untilMs, null, out);
  return out;
}

function collectAudible(
  project: Project,
  tracks: Track[],
  fromMs: number,
  untilMs: number,
  frame: CompFrame | null,
  out: Clip[],
): void {
  if ((frame?.depth ?? 0) > MAX_COMP_DEPTH) return;
  const delegated = delegatedLinkIds(tracks);
  for (const track of tracks) {
    if (!isTrackAudible(track, tracks)) continue;
    if ((track.volume ?? 1) <= 0) continue;
    for (const clip of track.clips) {
      if (clip.volume <= 0 || hasVelocity(clip)) continue;
      const scheduled = frame ? projectClip(clip, frame) : clip;
      if (!scheduled) continue;
      if (clipEndMs(scheduled) <= fromMs || scheduled.timelineStartMs >= untilMs) continue;
      if (isCompClip(scheduled)) {
        const comp = findComp(project, scheduled.compId);
        if (!comp) continue;
        const scale = 1 / (scheduled.speed || 1);
        collectAudible(
          project,
          comp.tracks,
          Math.max(fromMs, scheduled.timelineStartMs),
          Math.min(untilMs, clipEndMs(scheduled)),
          {
            offsetMs: scheduled.timelineStartMs - scheduled.sourceInMs * scale,
            scale,
            prefix: `${frame?.prefix ?? ''}${clip.id}/`,
            // Never read on this path: nothing is wired up, only listed.
            destination: null as unknown as AudioNode,
            visFromMs: scheduled.timelineStartMs,
            visToMs: clipEndMs(scheduled),
            depth: (frame?.depth ?? 0) + 1,
          },
          out,
        );
        continue;
      }
      if (isGeneratedClip(scheduled)) continue;
      // The video side of a link delegates its sound to the group's audio clips.
      if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
      out.push(scheduled);
    }
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
  /** Which timeline to mix: the project's own, or a composition being auditioned. */
  compId: CompId = null,
): MixScheduler {
  const scheduler = new MixScheduler(ctx, destination, getSegments, fromMs, startAtCtxTime, rate);
  scheduler.extend(project, fromMs, fromMs + durationMs, compId);
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
  // Compositions carry sound of their own, so an edit two precomps deep changes
  // the mix exactly as an edit on the timeline does. Compared by identity first,
  // which copy-on-write makes free for every composition the edit did not touch.
  const ca = a.comps ?? [];
  const cb = b.comps ?? [];
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) {
    if (ca[i] === cb[i]) continue;
    if (ca[i]!.id !== cb[i]!.id) return false;
    if (!sameLaneAudio(ca[i]!.tracks, cb[i]!.tracks)) return false;
  }
  return sameLaneAudio(a.tracks, b.tracks);
}

/** The per-lane half of `sameAudioMix`, shared by the timeline and every comp. */
function sameLaneAudio(la: Track[], lb: Track[]): boolean {
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) {
    const ta = la[i]!;
    const tb = lb[i]!;
    if (ta === tb) continue;
    if (
      ta.id !== tb.id ||
      ta.kind !== tb.kind ||
      !!ta.muted !== !!tb.muted ||
      !!ta.solo !== !!tb.solo ||
      (ta.volume ?? 1) !== (tb.volume ?? 1) ||
      !sameAudioFx(ta.audioFx, tb.audioFx) ||
      ta.clips.length !== tb.clips.length
    ) {
      return false;
    }
    for (let j = 0; j < ta.clips.length; j++) {
      const clipA = ta.clips[j]!;
      const clipB = tb.clips[j]!;
      if (clipA === clipB) continue;
      if (!sameAudioClip(clipA, clipB)) return false;
    }
  }
  return true;
}

function sameAudioClip(a: Clip, b: Clip): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.assetId === b.assetId &&
    (a.kind !== 'comp' || a.compId === (b as typeof a).compId) &&
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

/** Whether two chains - a clip's or a track's - hold the same effects, in order. */
function sameAudioFx(a: AudioFx[] | undefined, b: AudioFx[] | undefined): boolean {
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    if (a![i]!.type !== b![i]!.type || a![i]!.amount !== b![i]!.amount) return false;
  }
  return true;
}
