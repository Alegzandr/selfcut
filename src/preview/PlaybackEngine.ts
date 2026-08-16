import { useStore, EditorState } from '../store/store';
import { MediaAsset, MediaClip, Project } from '../types';
import {
  delegatedLinkIds,
  isTextClip,
  outputDimensions,
  projectDurationMs,
  timelineToSourceMs,
} from '../model';
import { loadFonts, onFontLoaded } from '../lib/fonts';
import { FRAME_MS, PREVIEW_RESOLUTION_SCALE } from '../app/config';
import { audioKey, getAudioBuffer, getStillFrame } from '../media/mediaCache';
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
import { ScheduledSource, sameAudioMix, scheduleProjectAudio, stopScheduled } from './audioMix';
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
   * Rasterized stills per image asset. `frame: null` marks a decode in flight
   * (or failed) so it is kicked once, not every frame; the File reference
   * detects a reconnected source (same id, new file) and re-rasterizes.
   */
  private stills = new Map<string, { file: File; frame: DrawableFrame | null }>();
  private scheduled: ScheduledSource[] = [];
  private audioBuffers = new Map<string, AudioBuffer | null>();
  private audioDirty = false;
  /** Set whenever the canvas must repaint (new frame, edit, seek). Idle frames skip drawing. */
  private videoDirty = true;
  private lastDrawnMs = -1;
  private raf = 0;
  private disposed = false;
  private unsubscribeFonts?: () => void;

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
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeFonts?.();
    cancelAnimationFrame(this.raf);
    stopScheduled(this.scheduled);
    this.scheduled = [];
    for (const cursor of this.cursors.values()) cursor.dispose();
    this.cursors.clear();
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
    stopScheduled(this.scheduled);

    // Kick decoding for any (asset, audio track) pair we don't have a buffer for
    // yet - a multi-track clip pulls its own source track, keyed independently.
    const delegated = delegatedLinkIds(state.project);
    for (const track of state.project.tracks) {
      for (const clip of track.clips) {
        // A linked video clip delegates its sound to its audio partners and is
        // never scheduled (see audioMix): decoding its primary track here would
        // duplicate their buffers (~23 MB per stereo minute, twice).
        if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
        const asset = state.assets[clip.assetId];
        if (!asset?.hasAudio) continue;
        const key = audioKey(asset.id, clip.audioTrackIndex);
        if (this.audioBuffers.has(key)) continue;
        this.audioBuffers.set(key, null);
        void getAudioBuffer(asset, clip.audioTrackIndex).then((buffer) => {
          this.audioBuffers.set(key, buffer);
          if (buffer) this.audioDirty = true;
        });
      }
    }

    const startCtx = this.audioCtx.currentTime + 0.03;
    this.anchorCtxTime = startCtx;
    this.anchorMediaMs = fromMs;
    this.rate = state.playbackRate;
    this.scheduled = scheduleProjectAudio(
      this.audioCtx,
      (trackId) => this.busFor(trackId).gain,
      state.project,
      (assetId, audioTrackIndex) => this.audioBuffers.get(audioKey(assetId, audioTrackIndex)) ?? null,
      fromMs,
      startCtx,
      this.rate,
    );
  }

  private stopAudio(): void {
    stopScheduled(this.scheduled);
    this.scheduled = [];
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
      if (this.wasPlaying) this.restartAt(state, state.currentTimeMs);
    }

    if (state.playing && !this.wasPlaying) {
      this.ensureAudio();
      this.wasPlaying = true;
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

    if (this.audioDirty) {
      this.audioDirty = false;
      if (this.wasPlaying) this.restartAt(state, this.playbackTimeMs(state));
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
        this.restartAt(state, t);
      } else if (t >= duration) {
        t = duration;
        this.wasPlaying = false;
        this.stopAudio();
        state.setPlaying(false);
      }
      state.setCurrentTimeFromEngine(t);
    }

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

    // Repaint on a new frame, an edit, OR a resolution change (same frame, new rung).
    if (this.videoDirty || t !== this.lastDrawnMs || renderScale !== this.lastRenderScale) {
      if (perfEnabled() && this.wasPlaying && this.lastDrawnMs >= 0) {
        // Audio is the clock, so a frame the renderer could not keep up with is
        // simply never drawn. Counting the frames the timeline skipped over is
        // the only way that shows up as a number instead of as "it feels rough".
        const skipped = Math.round((t - this.lastDrawnMs) / FRAME_MS) - 1;
        if (skipped > 0) count('droppedFrames', skipped);
      }
      if (t !== this.lastDrawnMs) this.lastFrameChangeAt = now;
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
        });
        // Inserted without the delete/re-insert the drawn clips do: a warming
        // cursor is the youngest entry once, and `live` keeps it safe after.
        this.cursors.set(clip.id, cursor);
      }
      cursor.prewarm(timelineToSourceMs(clip, clip.timelineStartMs) / 1000);
    }
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
    const liveAudioKeys = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        liveIds.add(clip.id);
        liveAudioKeys.add(audioKey(clip.assetId, clip.audioTrackIndex));
      }
    }
    for (const [clipId, cursor] of this.cursors) {
      if (!liveIds.has(clipId)) {
        cursor.dispose();
        this.cursors.delete(clipId);
      }
    }
    // Stills of assets no longer on the timeline: drop the lookup entry (the
    // bitmap itself is owned and closed by the media cache).
    const liveAssetIds = new Set<string>();
    for (const track of project.tracks) for (const clip of track.clips) liveAssetIds.add(clip.assetId);
    for (const assetId of [...this.stills.keys()]) {
      if (!liveAssetIds.has(assetId)) this.stills.delete(assetId);
    }
    // Decoded audio no longer referenced by any clip can be large - drop it,
    // per (asset, audio track) so one track's buffer never evicts another's.
    for (const key of [...this.audioBuffers.keys()]) {
      if (!liveAudioKeys.has(key)) this.audioBuffers.delete(key);
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
