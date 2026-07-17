import type { VideoSample } from 'mediabunny';
import { useStore, EditorState } from '../store/store';
import { Project } from '../types';
import { outputDimensions, projectDurationMs, timelineToSourceMs } from '../model';
import { PREVIEW_RESOLUTION_SCALE } from '../app/config';
import { audioKey, getAudioBuffer } from '../media/mediaCache';
import { FrameCursor } from './FrameCursor';
import { drawClip, visibleVideoClips } from './compositor';
import { ScheduledSource, scheduleProjectAudio, stopScheduled } from './audioMix';
import { TrackLevels, publishLevels } from './meterBus';

/**
 * After the playhead stops, delay before the paused still is re-rendered at full
 * resolution (draft while scrubbing so weak machines stay responsive, sharp once
 * it settles). Matches Premiere's "Paused Resolution = Full".
 */
const PREVIEW_PAUSE_SETTLE_MS = 140;

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
  private trackBuses = new Map<string, TrackBus>();
  private metersLive = false;
  private cursors = new Map<string, FrameCursor>();
  private scheduled: ScheduledSource[] = [];
  private audioBuffers = new Map<string, AudioBuffer | null>();
  private audioDirty = false;
  /** Set whenever the canvas must repaint (new frame, edit, seek). Idle frames skip drawing. */
  private videoDirty = true;
  private lastDrawnMs = -1;
  private raf = 0;
  private disposed = false;

  /** Render scale the last painted frame used - a rung change alone forces a repaint. */
  private lastRenderScale = 0;
  /** performance.now() of the last frame-time change (drives the paused-still refine). */
  private lastFrameChangeAt = 0;

  private wasPlaying = false;
  private lastSeekVersion: number;
  private lastProject: Project;
  private anchorCtxTime = 0;
  private anchorMediaMs = 0;
  /** Shuttle rate captured at the last (re)start - timeline advances at ctx-time × rate. */
  private rate = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    // High-quality resampling: scaled frames (crop/zoom/fit) look far cleaner
    // than the default 'low' bilinear pass.
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    const state = useStore.getState();
    this.lastSeekVersion = state.seekVersion;
    this.lastProject = state.project;
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
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

  /** (Re)start audio playback from a given timeline position. */
  private restartAt(state: EditorState, fromMs: number): void {
    if (!this.audioCtx || !this.masterGain) return;
    stopScheduled(this.scheduled);

    // Kick decoding for any (asset, audio track) pair we don't have a buffer for
    // yet - a multi-track clip pulls its own source track, keyed independently.
    for (const track of state.project.tracks) {
      for (const clip of track.clips) {
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

    // Shuttle rate changed mid-playback (J/L): re-anchor with the old rate, reschedule with the new.
    if (this.wasPlaying && state.playbackRate !== this.rate) {
      this.restartAt(state, this.playbackTimeMs(state));
    }

    if (state.project !== this.lastProject) {
      this.lastProject = state.project;
      this.videoDirty = true;
      this.pruneCursors(state.project);
      if (this.wasPlaying) this.restartAt(state, this.playbackTimeMs(state));
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

    // Preview resolution: composite at the chosen rung while playing. A rung
    // that still can't keep up is absorbed by frame dropping (audio is the
    // clock), so the picture never changes sharpness mid-playback. The paused
    // still refines to full resolution once the playhead settles (draft while
    // scrubbing, sharp when it stops) - the Premiere "Paused Resolution = Full".
    const rung = PREVIEW_RESOLUTION_SCALE[state.previewResolution];
    const now = performance.now();
    const renderScale =
      !this.wasPlaying && now - this.lastFrameChangeAt > PREVIEW_PAUSE_SETTLE_MS ? 1 : rung;

    // Repaint on a new frame, an edit, OR a resolution change (same frame, new rung).
    if (this.videoDirty || t !== this.lastDrawnMs || renderScale !== this.lastRenderScale) {
      if (t !== this.lastDrawnMs) this.lastFrameChangeAt = now;
      this.videoDirty = false;
      this.lastDrawnMs = t;
      this.lastRenderScale = renderScale;
      // A single bad frame must never kill the preview loop.
      try {
        this.draw(state, t, renderScale);
      } catch (err) {
        console.warn('[preview] draw failed, frame dropped:', err);
      }
    }
    this.publishMeters();
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(state: EditorState, tMs: number, scale: number): void {
    const { width, height } = outputDimensions(state.project.aspectRatio);
    // Composite at a fraction of the export size - cheaper, and the browser
    // upscales the backing store to fill the monitor.
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // Resizing the backing store resets all context state - re-arm smoothing.
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    }

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);

    // Track order defines z-order: the last video track draws on top. Within
    // a track, an overlapping pair draws earliest-first - the incoming clip
    // composites over the outgoing one with rising alpha (crossfade).
    for (const track of state.project.tracks) {
      const alphaMul = track.opacity ?? 1;
      if (alphaMul <= 0) continue;
      for (const { clip, xfadeInMs } of visibleVideoClips(track, tMs)) {
        let sample: VideoSample | null = null;
        if (clip.kind === 'media') {
          const asset = state.assets[clip.assetId];
          if (!asset) continue;
          let cursor = this.cursors.get(clip.id);
          if (!cursor) {
            cursor = new FrameCursor(asset, () => {
              this.videoDirty = true;
            });
            this.cursors.set(clip.id, cursor);
          }
          cursor.request(timelineToSourceMs(clip, tMs) / 1000, this.wasPlaying);
          sample = cursor.sample;
        }
        drawClip(this.ctx, clip, w, h, tMs, alphaMul, xfadeInMs, sample);
      }
    }
  }

  /** Feed the track header meters (peak per track) while audio is playing. */
  private publishMeters(): void {
    if (this.wasPlaying && this.trackBuses.size > 0) {
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
