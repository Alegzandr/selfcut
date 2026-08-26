import { useStore, EditorState } from '../store/store';
import { MediaAsset, MediaClip, Project } from '../types';
import {
  clipEndMs,
  delegatedLinkIds,
  isTextClip,
  outputDimensions,
  projectDurationMs,
  timelineToSourceMs,
} from '../model';
import { loadFonts, onFontLoaded } from '../lib/fonts';
import { FRAME_MS, PREVIEW_RESOLUTION_SCALE } from '../app/config';
import { getStillFrame, peekAudioRange, prefetchAudioRange } from '../media/mediaCache';
import type { DrawableFrame } from '../media/stillImage';
import { FrameCursor } from './FrameCursor';
import { frameBytes, maxLiveCursors, selectCursorEvictions } from './cursorPool';
import {
  drawClip,
  forEachUpcomingVideoClip,
  forEachVisibleVideoClip,
  invalidateResampling,
} from './compositor';
import { count, endFrame, endSpan, perfEnabled, record, span } from '../perf/probe';
import { syncLuts } from './colorPass';
import { SCOPE_SAMPLE_WIDTH } from './scopes';
import { hasScopeListeners, publishScopeFrame } from './scopeBus';
import { renderPreviewFrame, subscribeRenderPreview } from '../export/renderPreviewBus';
import { MixScheduler, sameAudioMix } from './audioMix';
import { TrackLevels, hasLevelListeners, publishLevels } from './meterBus';

/**
 * Register the faces a project's text clips ask for. Idempotent, so calling it
 * on every project change costs a map lookup once the face is warm.
 */
function ensureProjectFonts(project: Project): void {
  void loadFonts(
    project.tracks.flatMap((track) => track.clips.filter(isTextClip).map((clip) => clip.text.font)),
  );
}

/**
 * After the playhead stops, delay before the paused still is re-rendered at full
 * resolution (draft while scrubbing so weak machines stay responsive, sharp once
 * it settles). Matches Premiere's "Paused Resolution = Full".
 */
const PREVIEW_PAUSE_SETTLE_MS = 140;

/**
 * Shortest gap between two scope updates while playing (20 Hz).
 *
 * The scopes read the composited frame back from the GPU, which stalls the CPU
 * on the GPU. Twenty updates a second is well past what an eye can resolve on a
 * waveform and costs a fifth of what sixty did.
 */
const SCOPE_MIN_INTERVAL_MS = 1000 / 20;

/**
 * How far ahead of the playhead, in timeline ms, a clip's decoder is opened.
 *
 * A cursor created at the instant its clip becomes visible has nothing decoded
 * to draw: opening the file, configuring the decoder and seeking to the keyframe
 * before the clip's in point takes a couple of hundred milliseconds on a large
 * source, and until the first frame lands the clip paints nothing - so a
 * straight cut flashed the black backdrop at every boundary. A second of lead
 * covers that on a slow source without keeping more than one extra decoder open.
 */
const PREWARM_LEAD_MS = 1000;

/**
 * First and longest gap between two attempts at a frame a paused preview is
 * still waiting for.
 *
 * A paused preview draws once and then idles: the only thing that repaints it
 * for a video clip is a frame arriving. So a first decode that never lands -
 * a request lost with a worker that restarted under it, a decode that failed
 * before the cursor ever produced anything, a sink that resolved after the one
 * draw that asked - leaves the monitor black with nothing left to ask again,
 * until the user happens to move the playhead. Which is exactly what "reload,
 * black picture, press back-to-start, picture" was.
 *
 * The retry backs off to a request every two seconds and then keeps going: a
 * clip whose source genuinely has no frame at that time (trimmed past the end
 * of its media) costs one seek every two seconds while it is on screen, which
 * is nothing, and giving up entirely is what left the picture black for the
 * rest of the session.
 */
const FRAME_RETRY_MS = 250;
const FRAME_RETRY_MAX_MS = 2000;

/**
 * How many upcoming clips may hold a warm decoder at once.
 *
 * Two: the next cut on a single track, or the pair a stacked layout cuts to at
 * the same instant. Beyond that the lead window is only holding decoders for
 * boundaries the playhead will not reach for a while, and a warm cursor is
 * protected from eviction (opening a decoder and dropping it before its clip is
 * reached would be absurd) - so this bound and the pool's own are what keep the
 * live decoder count in hand. Whichever is tighter wins.
 */
const PREWARM_MAX_CLIPS = 2;

/**
 * How long before a loop's out point the decoder for its in point is opened.
 *
 * A wrap is a backward seek, and a seek costs the decode of every frame from
 * the preceding keyframe: measured at 300-400 ms on 1440p120 footage with the
 * two-second keyframe interval a screen recorder writes. Paid at the wrap, that
 * is the picture standing still while the audio has already started the new
 * pass. Paid before it, on a second decoder parked on the in point, it is
 * nothing anybody sees - so the lead only has to be longer than the seek it
 * hides, with room for a machine having a bad moment.
 */
const LOOP_PREROLL_LEAD_MS = 900;

/**
 * How still the playhead must be before a PAUSED preview parks a decoder for
 * the playback that has not been asked for yet.
 *
 * Pressing play pays the same seek: a paused cursor answers from random access
 * and the frames after it come from an iterator that does not exist yet. Parking
 * one while the preview idles turns that into an instant start.
 *
 * Longer than the full-resolution settle, deliberately. Every re-park is a
 * decoder opening and a keyframe-to-here decode, and a dragged playhead stops
 * for a moment at every value it crosses: waiting until the user has really
 * stopped is what keeps a scrub from opening a decoder per step.
 */
const PREROLL_SETTLE_MS = 400;

/**
 * How far ahead of the playhead audio is SCHEDULED, in timeline ms.
 *
 * Audio is decoded in segments (see `audioSegments.ts`), so playback is a row
 * of buffer sources handed to the context as the playhead approaches them
 * rather than one source per clip. The horizon has to be long enough that a
 * tick the browser skipped cannot leave a gap, and short enough that scheduling
 * an hour-long clip does not mean holding an hour of decoded audio.
 */
const AUDIO_SCHEDULE_HORIZON_MS = 20_000;

/**
 * Shortest gap between two scheduling passes.
 *
 * The pass walks every clip of the project, and re-running it is also how a
 * segment that finished decoding late gets picked up - so it wants to be
 * frequent, but not sixty times a second on a timeline with hundreds of clips.
 */
const AUDIO_SCHEDULE_INTERVAL_MS = 50;

/**
 * How far ahead of the playhead audio is DECODED, and how far behind is kept
 * warm.
 *
 * Further than the scheduling horizon, deliberately: a segment has to be
 * decoded before the window that plays it is scheduled, and a decode is a seek
 * plus 30 s of packets. The lead is scaled by the shuttle rate, so playing at
 * 4x asks for the audio four times sooner. The backward reach covers the small
 * step back a scrub makes constantly, which would otherwise re-decode.
 */
const AUDIO_PREFETCH_AHEAD_MS = 45_000;
const AUDIO_PREFETCH_BEHIND_MS = 5_000;

/** Shortest gap between two prefetch passes: it walks every clip too. */
const AUDIO_PREFETCH_INTERVAL_MS = 250;

interface TrackBus {
  /** Summing bus of the track's clips (post clip & track volume). */
  gain: GainNode;
  /** Tap for the header level meter. */
  analyser: AnalyserNode;
  data: Float32Array<ArrayBuffer>;
}


/**
 * Real-time preview: a rAF loop draws visible video frames on the canvas,
 * audio plays through a Web Audio graph. Entirely separate from the export pipeline.
 */
export class PlaybackEngine {
  private ctx: CanvasRenderingContext2D;
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** Master gain last written to the node - NaN forces the first write through. */
  private lastMasterGain = NaN;
  private trackBuses = new Map<string, TrackBus>();
  private metersLive = false;
  /**
   * Live decode cursors by clip id, in least-recently-drawn order: a cursor is
   * re-inserted on every use, so the Map's own iteration order IS the LRU
   * ranking `trimCursors` ranks by. See cursorPool.ts for why it is bounded.
   */
  private cursors = new Map<string, FrameCursor>();
  /**
   * Decoders parked on a position playback is about to jump to - the in point
   * of an armed loop, or where a paused playhead sits - keyed by clip. Promoted
   * into `cursors` when the jump happens (see `promotePrerollsAt`), which is
   * what makes the jump show a picture immediately instead of after a seek.
   */
  private prerolls = new Map<string, { cursor: FrameCursor; timelineMs: number }>();
  /** Instant `prerolls` is parked on, so re-arming it every tick costs nothing. */
  private parkedAtMs = NaN;
  /**
   * Rasterized stills per image asset. `frame: null` marks a decode in flight
   * (or failed) so it is kicked once, not every frame; the File reference
   * detects a reconnected source (same id, new file) and re-rasterizes.
   */
  private stills = new Map<string, { file: File; frame: DrawableFrame | null }>();
  /**
   * The live audio schedule, or null while stopped. Owns every node it created,
   * so replacing it is one `stop()` and a fresh anchor.
   */
  private mix: MixScheduler | null = null;
  /** `performance.now()` of the last schedule extension and the last prefetch pass. */
  private lastExtendAt = 0;
  private lastPrefetchAt = 0;
  /** Set whenever the canvas must repaint (new frame, edit, seek). Idle frames skip drawing. */
  private videoDirty = true;
  private lastDrawnMs = -1;
  private raf = 0;
  private disposed = false;
  private unsubscribeFonts?: () => void;
  private unsubscribeRenderPreview?: () => void;

  /** Render scale the last painted frame used - a rung change alone forces a repaint. */
  private lastRenderScale = 0;

  /**
   * Small offscreen the composited frame is downscaled into for the scopes, plus
   * whether a scope was mounted last tick. Lazily created on first use, so a
   * session that never opens the scopes panel never allocates it.
   */
  private scopeCanvas: OffscreenCanvas | null = null;
  private scopeCtx: OffscreenCanvasRenderingContext2D | null = null;
  private scopeActive = false;
  /** performance.now() of the last frame-time change (drives the paused-still refine). */
  private lastFrameChangeAt = 0;

  private wasPlaying = false;
  private lastSeekVersion: number;
  private lastProject: Project;
  private anchorCtxTime = 0;
  private anchorMediaMs = 0;
  /** Shuttle rate captured at the last (re)start - timeline advances at ctx-time × rate. */
  private rate = 1;

  /**
   * Largest decoded frame seen so far, in bytes: what the cursor pool's memory
   * budget is measured against. A high-water mark rather than a per-frame
   * reading, so a moment when only a small clip is on screen does not briefly
   * raise the cap and admit cursors the next 4K clip cannot afford.
   */
  private largestFrameBytes = frameBytes(1920, 1080);

  /** `performance.now()` of the previous tick, for the `tickGap` measurement. */
  private lastTickAt = 0;

  /** `performance.now()` of the last scope publish, for the rate cap. */
  private lastScopeAt = 0;

  /** A video clip drew with no decoded frame this pass (see FRAME_RETRY_MS). */
  private awaitingFrame = false;
  /** `performance.now()` of the last retry, and how many have been made since the last frame. */
  private lastFrameRetryAt = 0;
  private frameRetries = 0;

  /** Reused buffer of prewarm candidates, so the per-frame array is not garbage. */
  private prewarmScratch: { clip: MediaClip; asset: MediaAsset }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    // High-quality resampling: scaled frames (crop/zoom/fit) look far cleaner
    // than the default 'low' bilinear pass.
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    const state = useStore.getState();
    this.lastSeekVersion = state.seekVersion;
    this.lastProject = state.project;
    // The engine can be created AFTER a session is restored, in which case the
    // project reference never changes and the tick below would not kick this.
    ensureProjectFonts(state.project);
    // A paused preview draws once and then idles, so a face arriving after that
    // frame would stay invisible until the next edit.
    this.unsubscribeFonts = onFontLoaded(() => {
      this.videoDirty = true;
    });
    // A render owns the monitor while it runs (see `draw`). Nothing about the
    // project or the playhead changes as it advances, so a fresh snapshot is
    // the only thing that can ask for the repaint that shows it - and the same
    // signal is what repaints the real frame once the render lets go.
    this.unsubscribeRenderPreview = subscribeRenderPreview(() => {
      this.videoDirty = true;
    });
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeFonts?.();
    this.unsubscribeRenderPreview?.();
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    for (const cursor of this.cursors.values()) cursor.dispose();
    this.cursors.clear();
    this.dropPrerolls();
    this.trackBuses.clear();
    if (this.metersLive) publishLevels({});
    void this.audioCtx?.close();
  }

  /** Per-track summing bus + analyser tap, created lazily, pruned with the project. */
  private busFor(trackId: string): TrackBus {
    let bus = this.trackBuses.get(trackId);
    if (!bus) {
      const gain = this.audioCtx!.createGain();
      gain.connect(this.masterGain!);
      const analyser = this.audioCtx!.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(analyser);
      bus = { gain, analyser, data: new Float32Array(analyser.fftSize) };
      this.trackBuses.set(trackId, bus);
    }
    return bus;
  }

  private ensureAudio(): void {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
  }

  /**
   * Push the master monitoring level onto the master bus. Listening level only:
   * it sits after the meter taps, so the track meters keep showing the mix as it
   * will be exported, and the export path never sees it at all.
   */
  private applyMasterVolume(state: EditorState): void {
    if (!this.audioCtx || !this.masterGain) return;
    const target = state.previewMuted ? 0 : state.previewVolume;
    if (target === this.lastMasterGain) return;
    this.lastMasterGain = target;
    // Short ramp instead of a step: an instant gain jump clicks.
    this.masterGain.gain.setTargetAtTime(target, this.audioCtx.currentTime, 0.01);
  }

  /** (Re)start audio playback from a given timeline position. */
  private restartAt(state: EditorState, fromMs: number): void {
    if (!this.audioCtx || !this.masterGain) return;
    this.mix?.stop();

    const startCtx = this.audioCtx.currentTime + 0.03;
    this.anchorCtxTime = startCtx;
    this.anchorMediaMs = fromMs;
    this.rate = state.playbackRate;
    this.mix = new MixScheduler(
      this.audioCtx,
      (trackId) => this.busFor(trackId).gain,
      peekAudioRange,
      fromMs,
      startCtx,
      this.rate,
    );
    // Zeroed so the first extension of the new schedule is never rate-limited.
    this.lastExtendAt = 0;
    // Ask for the audio around the new position before scheduling: a seek into
    // a cold region has nothing decoded, and the first window would otherwise
    // schedule silence and wait for the next tick to notice.
    this.prefetchAudio(state, fromMs, true);
    this.extendAudio(state, fromMs);
  }

  /**
   * Push the schedule forward, and pick up segments that have arrived since.
   *
   * Called every tick while playing. `extend` is idempotent per (clip,
   * segment), so re-scheduling the same window costs a walk of the project and
   * a few set lookups - and re-walking it is exactly what makes a segment that
   * finished decoding late audible without restarting anything.
   */
  private extendAudio(state: EditorState, tMs: number): void {
    if (!this.mix) return;
    const now = performance.now();
    if (now - this.lastExtendAt < AUDIO_SCHEDULE_INTERVAL_MS) return;
    this.lastExtendAt = now;
    // The window always starts at the playhead rather than at the last edge:
    // a segment that landed late belongs to a window already passed, and only
    // a window that still contains it can catch it.
    this.mix.extend(state.project, tMs, tMs + AUDIO_SCHEDULE_HORIZON_MS);
  }

  /**
   * Decode the audio the playhead is about to reach.
   *
   * Nothing else does: the mix only ever reads what is already decoded, so this
   * is the entire reason there is sound past the first segment. The lead has to
   * cover a decode (a seek plus 30 s of packets) at playback speed, and the
   * cache's own budget is what stops it from running away on a long timeline.
   *
   * Rate-limited rather than run per frame - it walks every clip - and run
   * while paused too, so pressing play does not start with a decode.
   */
  private prefetchAudio(state: EditorState, tMs: number, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastPrefetchAt < AUDIO_PREFETCH_INTERVAL_MS) return;
    this.lastPrefetchAt = now;

    const from = Math.max(0, tMs - AUDIO_PREFETCH_BEHIND_MS);
    const until = tMs + AUDIO_PREFETCH_AHEAD_MS * (this.wasPlaying ? this.rate : 1);
    const delegated = delegatedLinkIds(state.project);
    for (const track of state.project.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        // A linked video clip delegates its sound to its audio partners and is
        // never scheduled (see audioMix): decoding its primary track here would
        // hold the same audio twice.
        if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
        if (clip.volume <= 0) continue;
        const clipEnd = clipEndMs(clip);
        if (clipEnd <= from || clip.timelineStartMs >= until) continue;
        const asset = state.assets[clip.assetId];
        if (!asset?.hasAudio) continue;
        const speed = clip.speed || 1;
        const windowFrom = Math.max(from, clip.timelineStartMs);
        const windowTo = Math.min(until, clipEnd);
        prefetchAudioRange(
          asset,
          clip.audioTrackIndex,
          clip.sourceInMs + (windowFrom - clip.timelineStartMs) * speed,
          Math.min(clip.sourceOutMs, clip.sourceInMs + (windowTo - clip.timelineStartMs) * speed),
        );
      }
    }
  }

  private stopAudio(): void {
    this.mix?.stop();
    this.mix = null;
  }

  private playbackTimeMs(state: EditorState): number {
    if (this.wasPlaying && this.audioCtx) {
      return (
        this.anchorMediaMs +
        Math.max(0, this.audioCtx.currentTime - this.anchorCtxTime) * 1000 * this.rate
      );
    }
    return state.currentTimeMs;
  }

  private tick = (): void => {
    if (this.disposed) return;
    const frameStarted = span();
    const state = useStore.getState();

    if (state.seekVersion !== this.lastSeekVersion) {
      this.lastSeekVersion = state.seekVersion;
      // Parked where the playhead no longer is, and a promotion would show that
      // stale frame for a moment. Re-parked once the new position settles.
      this.dropPrerolls();
      if (this.wasPlaying) this.restartAt(state, state.currentTimeMs);
    }

    if (state.playing && !this.wasPlaying) {
      this.ensureAudio();
      this.wasPlaying = true;
      // The decoder parked while the preview idled is already sitting on this
      // frame, with the ones after it queued behind: taking it over here is what
      // makes the first frame of a playback appear at once.
      this.promotePrerollsAt(state.currentTimeMs);
      this.restartAt(state, state.currentTimeMs);
    } else if (!state.playing && this.wasPlaying) {
      this.wasPlaying = false;
      this.stopAudio();
    }

    // After ensureAudio, so the very first scheduled sources (which start at
    // currentTime + 30 ms) already play at the user's monitoring level.
    this.applyMasterVolume(state);

    // Shuttle rate changed mid-playback (J/L): re-anchor with the old rate, reschedule with the new.
    if (this.wasPlaying && state.playbackRate !== this.rate) {
      this.restartAt(state, this.playbackTimeMs(state));
    }

    if (state.project !== this.lastProject) {
      const previous = this.lastProject;
      this.lastProject = state.project;
      this.videoDirty = true;
      this.pruneCursors(state.project);
      ensureProjectFonts(state.project);
      // Only an edit that changes the mix is worth tearing the graph down for:
      // a transform drag fires updateClip on every pointermove, and
      // rescheduling there stutters the audio for nothing.
      if (this.wasPlaying && !sameAudioMix(previous, state.project)) {
        this.restartAt(state, this.playbackTimeMs(state));
      }
    }

    let t = state.currentTimeMs;
    if (this.wasPlaying) {
      t = this.playbackTimeMs(state);
      const duration = projectDurationMs(state.project);
      // Loop region armed: wrap back to its in point instead of running to the end.
      const loop = state.loopEnabled ? state.loopRegion : null;
      const loopEnd = loop ? Math.min(loop.endMs, duration) : 0;
      if (loop && loopEnd > loop.startMs && t >= loopEnd) {
        t = loop.startMs;
        this.promotePrerollsAt(t);
        this.restartAt(state, t);
      } else if (t >= duration) {
        t = duration;
        this.wasPlaying = false;
        this.stopAudio();
        state.setPlaying(false);
      }
      state.setCurrentTimeFromEngine(t);
    }

    // Audio is scheduled one window at a time and decoded a window ahead of
    // that, so both have to be pushed forward as the playhead moves. Paused,
    // only the prefetch runs - which is what makes pressing play instant
    // instead of starting with a decode.
    if (this.wasPlaying) this.extendAudio(state, t);
    this.prefetchAudio(state, t);

    // Trim preview: while an edge is being dragged, the picture shows the frame
    // at that edge instead of the playhead's. Applied after the playback branch
    // so the transport clock (and `setCurrentTimeFromEngine`) stays untouched -
    // only what gets composited changes.
    if (state.previewOverrideMs !== null) t = state.previewOverrideMs;

    // Preview resolution: composite at the chosen rung while playing. A rung
    // that still can't keep up is absorbed by frame dropping (audio is the
    // clock), so the picture never changes sharpness mid-playback. The paused
    // still refines to full resolution once the playhead settles (draft while
    // scrubbing, sharp when it stops) - the Premiere "Paused Resolution = Full".
    // The scopes panel just opened (or was hidden): a paused preview draws once
    // and then idles, so force one repaint on the transition so the scope
    // populates immediately from the current still instead of staying empty.
    const scopeActive = hasScopeListeners();
    if (scopeActive !== this.scopeActive) {
      this.scopeActive = scopeActive;
      if (scopeActive) this.videoDirty = true;
    }

    const rung = PREVIEW_RESOLUTION_SCALE[state.previewResolution];
    const now = performance.now();
    const renderScale =
      !this.wasPlaying && now - this.lastFrameChangeAt > PREVIEW_PAUSE_SETTLE_MS ? 1 : rung;

    this.schedulePrerolls(state, t, now);

    // Still waiting on the first frame of a clip that is on screen: ask again.
    // Paused, nothing else will - the request that would have brought the
    // picture back is the one the repaint itself issues.
    const retryWait = Math.min(
      FRAME_RETRY_MAX_MS,
      FRAME_RETRY_MS * 2 ** Math.min(this.frameRetries, 8),
    );
    if (!this.wasPlaying && this.awaitingFrame && now - this.lastFrameRetryAt > retryWait) {
      this.lastFrameRetryAt = now;
      this.frameRetries++;
      this.videoDirty = true;
    }

    // Repaint on a new frame, an edit, OR a resolution change (same frame, new rung).
    if (this.videoDirty || t !== this.lastDrawnMs || renderScale !== this.lastRenderScale) {
      if (perfEnabled() && this.wasPlaying && this.lastDrawnMs >= 0) {
        // Audio is the clock, so a frame the renderer could not keep up with is
        // simply never drawn. Counting the frames the timeline skipped over is
        // the only way that shows up as a number instead of as "it feels rough".
        const skipped = Math.round((t - this.lastDrawnMs) / FRAME_MS) - 1;
        if (skipped > 0) count('droppedFrames', skipped);
      }
      if (t !== this.lastDrawnMs) {
        this.lastFrameChangeAt = now;
        // A new frame time is a new decode to wait for: the previous one's
        // budget of retries says nothing about this one.
        this.frameRetries = 0;
      }
      this.videoDirty = false;
      this.lastDrawnMs = t;
      this.lastRenderScale = renderScale;
      // A single bad frame must never kill the preview loop.
      const drawStarted = span();
      try {
        this.draw(state, t, renderScale);
      } catch (err) {
        console.warn('[preview] draw failed, frame dropped:', err);
      }
      endSpan('draw', drawStarted);
    }
    this.publishMeters();
    endSpan('frame', frameStarted);
    // The gap between two ticks, which is the only number that includes what
    // this loop does NOT control: React reconciliation, garbage collection, the
    // browser's own compositing. `frame` says what the engine spends; `tickGap`
    // says what the user actually gets.
    if (frameStarted !== -1) {
      if (this.lastTickAt > 0) record('tickGap', frameStarted - this.lastTickAt);
      this.lastTickAt = frameStarted;
    }
    endFrame();
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(state: EditorState, tMs: number, scale: number): void {
    // A render in flight owns the picture. Showing the frame being encoded is
    // the only thing on screen that says what an export is actually doing, and
    // compositing the playhead's own frame underneath it would be work nobody
    // ever sees - so this returns before any decoding is asked for.
    const rendering = renderPreviewFrame();
    if (rendering) {
      this.drawRenderPreview(rendering.bitmap);
      return;
    }

    // Hand the colour pass the project's current LUT set before any clip grades.
    // Reference-equal when nothing changed, so this is a cheap per-frame guard.
    syncLuts(state.project.luts);
    const { width, height } = outputDimensions(state.project.aspectRatio);
    // Composite at a fraction of the export size - cheaper, and the browser
    // upscales the backing store to fill the monitor.
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // Resizing the backing store resets all context state, including the
      // resampling mode the compositor caches per context.
      invalidateResampling(this.ctx);
    }

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);

    // Track order defines z-order the way the timeline shows it: the first
    // track is the top lane, so tracks paint bottom-up and the top lane lands
    // last, over the others. Within a track, an overlapping pair draws
    // earliest-first - the incoming clip composites over the outgoing one with
    // rising alpha (crossfade).
    // Clips that hold a cursor this frame - either drawn, or warming up for a
    // cut that is about to happen. Never eviction candidates, however long ago
    // the last one was created (see trimCursors).
    const liveClipIds = new Set<string>();
    // Re-measured every pass: a clip that has no decoded frame yet is what
    // keeps the retry above alive, and it must stop the moment one lands.
    this.awaitingFrame = false;
    const tracks = state.project.tracks;
    for (let t = tracks.length - 1; t >= 0; t--) {
      const track = tracks[t]!;
      const alphaMul = track.opacity ?? 1;
      if (alphaMul <= 0) continue;
      forEachVisibleVideoClip(track, tMs, (clip, xfadeInMs) => {
        let sample: DrawableFrame | null = null;
        if (clip.kind === 'media') {
          const asset = state.assets[clip.assetId];
          if (!asset) return;
          if (asset.kind === 'image') {
            sample = this.ensureStill(asset);
          } else {
            let cursor = this.cursors.get(clip.id);
            if (!cursor) {
              cursor = new FrameCursor(asset, () => {
                this.videoDirty = true;
                this.frameRetries = 0;
              });
            } else {
              // Delete before re-inserting: a Map keeps insertion order, so
              // this is what moves the clip to the young end of the ranking.
              this.cursors.delete(clip.id);
            }
            this.cursors.set(clip.id, cursor);
            liveClipIds.add(clip.id);
            cursor.request(timelineToSourceMs(clip, tMs) / 1000, this.wasPlaying);
            sample = cursor.sample;
            if (!sample) this.awaitingFrame = true;
            // What the pool's memory cap is actually measured against. Taken
            // from the decoded frame rather than from the asset's declared
            // size, so a source that decodes to something unexpected is still
            // budgeted for what it really costs.
            if (sample) {
              this.largestFrameBytes = Math.max(
                this.largestFrameBytes,
                frameBytes(sample.displayWidth, sample.displayHeight),
              );
            }
          }
        }
        drawClip(this.ctx, clip, w, h, tMs, alphaMul, xfadeInMs, sample);
      });
    }

    this.prewarmUpcoming(state, tMs, liveClipIds);
    this.trimCursors(liveClipIds);

    if (hasScopeListeners()) {
      const started = span();
      this.publishScope(w, h);
      endSpan('scopes', started);
    }
  }

  /**
   * Paint the snapshot the export worker sent.
   *
   * The bitmap was downscaled from the output frame, so it already carries the
   * project's aspect ratio: the backing store simply takes its size and the
   * browser scales it to the monitor, exactly as it does for the reduced rungs
   * a playing preview composites at.
   */
  private drawRenderPreview(bitmap: ImageBitmap): void {
    const w = bitmap.width;
    const h = bitmap.height;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // Resizing the backing store resets context state, resampling included.
      invalidateResampling(this.ctx);
    }
    this.ctx.drawImage(bitmap, 0, 0, w, h);
  }

  /**
   * The rasterized bitmap of an image asset, kicking the decode on first use.
   * `frame: null` marks one in flight (or failed) so it is asked for once, not
   * every frame.
   */
  private ensureStill(asset: MediaAsset): DrawableFrame | null {
    let entry = this.stills.get(asset.id);
    if (!entry || entry.file !== asset.file) {
      const fresh = { file: asset.file, frame: null as DrawableFrame | null };
      this.stills.set(asset.id, fresh);
      entry = fresh;
      void getStillFrame(asset).then((still) => {
        if (still && this.stills.get(asset.id) === fresh) {
          fresh.frame = still;
          this.videoDirty = true;
        }
      });
    }
    return entry.frame;
  }

  /**
   * Open the decoders of the clips the playhead is about to reach, so a cut
   * shows the incoming clip's first frame instead of the black backdrop while a
   * cold cursor demuxes and seeks.
   *
   * Playback only: paused, the playhead is not heading anywhere, and holding a
   * decoder open for a clip that may never be reached is pure cost. The warmed
   * clips join `live` so the pool cannot evict the decoder it just opened, which
   * is also why they are capped by whatever room the pool has left: a protected
   * set larger than the pool's own budget is a budget that no longer holds.
   */
  private prewarmUpcoming(state: EditorState, tMs: number, live: Set<string>): void {
    if (!this.wasPlaying) return;
    // `live` holds the clips drawn this frame - what is on screen always comes
    // first, so a stack deep enough to fill the pool simply gets no prewarm.
    const room = Math.min(PREWARM_MAX_CLIPS, this.cursorCap() - live.size);
    if (room <= 0) return;
    // Shuttling covers the same lead in less wall-clock time, so the window has
    // to grow with the rate to keep buying the same head start.
    const lead = PREWARM_LEAD_MS * Math.max(1, this.rate);
    const candidates = this.prewarmScratch;
    candidates.length = 0;
    for (const track of state.project.tracks) {
      if ((track.opacity ?? 1) <= 0) continue;
      forEachUpcomingVideoClip(track, tMs, lead, (clip) => {
        if (clip.kind !== 'media') return;
        const asset = state.assets[clip.assetId];
        if (!asset) return;
        // A still costs a bitmap in a per-asset cache, not a decoder: no cap
        // needed, and warming it is what keeps a photo from cutting in black.
        if (asset.kind === 'image') this.ensureStill(asset);
        else candidates.push({ clip, asset });
      });
    }
    // The nearest cuts win the room there is: a fast-cut sequence can hold a
    // dozen clips in the lead window, and the ones after the next are not what
    // the next boundary needs decoded.
    if (candidates.length > room) {
      candidates.sort((a, b) => a.clip.timelineStartMs - b.clip.timelineStartMs);
      candidates.length = room;
    }
    for (const { clip, asset } of candidates) {
      live.add(clip.id);
      let cursor = this.cursors.get(clip.id);
      if (!cursor) {
        cursor = new FrameCursor(asset, () => {
          this.videoDirty = true;
          this.frameRetries = 0;
        });
        // Inserted without the delete/re-insert the drawn clips do: a warming
        // cursor is the youngest entry once, and `live` keeps it safe after.
        this.cursors.set(clip.id, cursor);
      }
      cursor.prewarm(timelineToSourceMs(clip, clip.timelineStartMs) / 1000);
    }
  }

  /**
   * Keep a decoder parked on the frame playback is about to need.
   *
   * Two moments deserve one, and they are the same problem: a jump the transport
   * is going to make, whose destination no decoder is positioned on. An armed
   * loop about to wrap, and a paused preview about to be played. What the parked
   * decoder buys is the seek - the decode of a whole keyframe interval - being
   * paid before the jump instead of after it, where it is a picture standing
   * still while the audio has already moved on.
   */
  private schedulePrerolls(state: EditorState, tMs: number, now: number): void {
    if (this.wasPlaying) {
      const loop = state.loopEnabled ? state.loopRegion : null;
      const loopEnd = loop ? Math.min(loop.endMs, projectDurationMs(state.project)) : 0;
      if (!loop || loopEnd <= loop.startMs) {
        this.dropPrerolls();
        return;
      }
      // Shuttling covers the same lead in less wall-clock time, so the window
      // grows with the rate - same reasoning as the prewarm window.
      if (tMs < loopEnd - LOOP_PREROLL_LEAD_MS * Math.max(1, this.rate)) return;
      this.parkAt(state, loop.startMs);
      return;
    }
    // A trim drag paints an edge rather than the playhead: what playback would
    // start from is not what is on screen, so there is nothing to park on yet.
    if (state.previewOverrideMs !== null) return;
    if (now - this.lastFrameChangeAt < PREROLL_SETTLE_MS) return;
    this.parkAt(state, tMs);
  }

  /** Open (or keep) a parked decoder for every video clip visible at `timelineMs`. */
  private parkAt(state: EditorState, timelineMs: number): void {
    if (this.parkedAtMs === timelineMs) return;
    // What is on screen comes first: a preroll may only use the room the pool
    // has left, and never more clips than the prewarm window allows.
    const room = Math.min(PREWARM_MAX_CLIPS, this.cursorCap() - this.cursors.size);
    const wanted = new Set<string>();
    for (const track of state.project.tracks) {
      if ((track.opacity ?? 1) <= 0) continue;
      forEachVisibleVideoClip(track, timelineMs, (clip) => {
        if (clip.kind !== 'media') return;
        const asset = state.assets[clip.assetId];
        // A still is a bitmap in a per-asset cache, not a decoder: nothing to park.
        if (!asset || asset.kind === 'image') return;
        wanted.add(clip.id);
        const parked = this.prerolls.get(clip.id);
        if (parked) {
          if (parked.timelineMs === timelineMs) return;
          parked.cursor.dispose();
          this.prerolls.delete(clip.id);
        }
        if (this.prerolls.size >= room) return;
        const cursor = new FrameCursor(asset, () => {
          this.videoDirty = true;
          this.frameRetries = 0;
        });
        // `prewarm`, not `request`: the worker leaves its iterator open on that
        // frame, so the frames after the jump come from a reader that never has
        // to seek either.
        cursor.prewarm(timelineToSourceMs(clip, timelineMs) / 1000);
        this.prerolls.set(clip.id, { cursor, timelineMs });
      });
    }
    for (const [clipId, parked] of this.prerolls) {
      if (!wanted.has(clipId)) {
        parked.cursor.dispose();
        this.prerolls.delete(clipId);
      }
    }
    // Only an instant something is ACTUALLY parked on is remembered. The guard
    // at the top of this method reads `parkedAtMs` as "this instant is already
    // covered", and a pass that parked nothing has covered nothing: the very
    // first tick after an import runs before the clip is on the timeline, finds
    // no visible video, and would otherwise claim the playhead's instant for
    // good - so a paused preview at 0 never parked a decoder at all, which is
    // exactly the frame a first press of play starts from.
    this.parkedAtMs = this.prerolls.size > 0 ? timelineMs : NaN;
  }

  /**
   * Hand the transport the decoders parked on the instant it just jumped to.
   *
   * A parked cursor already holds that frame, so the clip draws it on the very
   * next pass. Anything parked on a different instant is dropped rather than
   * promoted: showing a frame from where the playhead used to be, even for one
   * pass, is the flash this exists to remove.
   */
  private promotePrerollsAt(timelineMs: number): void {
    if (this.prerolls.size === 0) return;
    for (const [clipId, parked] of this.prerolls) {
      if (Math.abs(parked.timelineMs - timelineMs) > FRAME_MS / 2) {
        parked.cursor.dispose();
        continue;
      }
      this.cursors.get(clipId)?.dispose();
      this.cursors.set(clipId, parked.cursor);
      this.videoDirty = true;
    }
    this.prerolls.clear();
    this.parkedAtMs = NaN;
  }

  private dropPrerolls(): void {
    if (this.prerolls.size === 0 && Number.isNaN(this.parkedAtMs)) return;
    for (const parked of this.prerolls.values()) parked.cursor.dispose();
    this.prerolls.clear();
    this.parkedAtMs = NaN;
  }

  /**
   * How many decode cursors may be alive at once, right now.
   *
   * The cap is in bytes, not in cursors: eight 4K decoders are ~200 MB of
   * frames, eight 720p ones are ~25 MB, and a phone and a workstation do not
   * have the same room for either. `largestFrameBytes` is measured from the
   * frames actually in play, so a 4K timeline holds fewer cursors than an HD one
   * without anyone having to configure that.
   */
  private cursorCap(): number {
    return maxLiveCursors(
      this.largestFrameBytes,
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    );
  }

  /**
   * Release the decoders of clips the playhead has moved away from.
   *
   * Run per frame rather than on project change: the cursors that pile up are
   * the ones behind a playhead that keeps moving, and nothing about the project
   * changes as it does. A released clip decodes again from its next visit,
   * which is a seek the preview already performs on every scrub.
   */
  private trimCursors(visible: ReadonlySet<string>): void {
    const max = this.cursorCap();
    count('liveCursors', this.cursors.size);
    if (this.cursors.size <= max) return;
    for (const clipId of selectCursorEvictions(this.cursors.keys(), visible, max)) {
      this.cursors.get(clipId)?.dispose();
      this.cursors.delete(clipId);
    }
  }

  /**
   * Downscale the freshly composited frame to a small RGBA buffer and hand it to
   * the scopes panel. Reading back the full preview canvas (up to 1920×1080)
   * every frame would be far too costly, so the frame is drawn once into a
   * fixed-width scratch (≈256px) and only those pixels are read. Guarded by
   * `hasScopeListeners`, so nothing here runs while the panel is closed.
   */
  /**
   * Feed the scopes, at a rate they can use rather than at the rate the picture
   * changes.
   *
   * Reading pixels back is the one operation in the loop that makes the CPU
   * wait for the GPU, and it is not cheap: measured at 1.10 ms per frame on a
   * 1080p preview, which is 80% of everything else the loop does put together.
   * A waveform is a data display, not an animation - twenty updates a second is
   * past the point where an eye can tell, and it hands back four fifths of that
   * cost. While paused the readback happens on the repaint itself, which is rare.
   */
  private publishScope(w: number, h: number): void {
    if (this.wasPlaying) {
      const now = performance.now();
      if (now - this.lastScopeAt < SCOPE_MIN_INTERVAL_MS) return;
      this.lastScopeAt = now;
    }
    const sw = Math.min(SCOPE_SAMPLE_WIDTH, w);
    const sh = Math.max(1, Math.round((sw * h) / w));
    if (!this.scopeCanvas) {
      this.scopeCanvas = new OffscreenCanvas(sw, sh);
      this.scopeCtx = this.scopeCanvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.scopeCtx;
    if (!ctx) return;
    if (this.scopeCanvas.width !== sw || this.scopeCanvas.height !== sh) {
      this.scopeCanvas.width = sw;
      this.scopeCanvas.height = sh;
    }
    const downscaleStarted = span();
    ctx.drawImage(this.canvas, 0, 0, w, h, 0, 0, sw, sh);
    endSpan('scopeDownscale', downscaleStarted);
    // The stall: everything the GPU has queued for this canvas has to finish
    // before these bytes exist.
    const readStarted = span();
    const img = ctx.getImageData(0, 0, sw, sh);
    endSpan('scopeReadback', readStarted);
    publishScopeFrame({ data: img.data, width: sw, height: sh });
  }

  /** Feed the track header meters (peak per track) while audio is playing. */
  private publishMeters(): void {
    if (this.wasPlaying && this.trackBuses.size > 0 && hasLevelListeners()) {
      const levels: TrackLevels = {};
      for (const [trackId, bus] of this.trackBuses) {
        bus.analyser.getFloatTimeDomainData(bus.data);
        let peak = 0;
        for (let i = 0; i < bus.data.length; i++) {
          const v = Math.abs(bus.data[i]!);
          if (v > peak) peak = v;
        }
        levels[trackId] = peak;
      }
      publishLevels(levels);
      this.metersLive = true;
    } else if (this.metersLive) {
      this.metersLive = false;
      publishLevels({});
    }
  }

  private pruneCursors(project: Project): void {
    const liveIds = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        liveIds.add(clip.id);
      }
    }
    for (const [clipId, cursor] of this.cursors) {
      if (!liveIds.has(clipId)) {
        cursor.dispose();
        this.cursors.delete(clipId);
      }
    }
    for (const [clipId, parked] of this.prerolls) {
      if (!liveIds.has(clipId)) {
        parked.cursor.dispose();
        this.prerolls.delete(clipId);
      }
    }
    // Stills of assets no longer on the timeline: drop the lookup entry (the
    // bitmap itself is owned and closed by the media cache).
    const liveAssetIds = new Set<string>();
    for (const track of project.tracks) for (const clip of track.clips) liveAssetIds.add(clip.assetId);
    for (const assetId of [...this.stills.keys()]) {
      if (!liveAssetIds.has(assetId)) this.stills.delete(assetId);
    }
    // Buses of deleted tracks: disconnect so they stop feeding the master.
    const liveTrackIds = new Set(project.tracks.map((t) => t.id));
    for (const [trackId, bus] of this.trackBuses) {
      if (!liveTrackIds.has(trackId)) {
        bus.gain.disconnect();
        bus.analyser.disconnect();
        this.trackBuses.delete(trackId);
      }
    }
  }
}
