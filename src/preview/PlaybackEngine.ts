import type { VideoSample, VideoSampleSink } from 'mediabunny';
import { useStore, EditorState } from '../store/store';
import { MediaAsset, Project, outputDimensions, projectDurationMs, timelineToSourceMs } from '../types';
import { createVideoSink, getAudioBuffer } from '../media/mediaCache';
import { drawClipSample, topClipAt } from './compositor';
import { ScheduledSource, scheduleProjectAudio, stopScheduled } from './audioMix';

/**
 * Non-blocking video frame cursor for one clip. Requests are coalesced:
 * if a decode is in flight, only the latest requested time is kept
 * (frames are dropped rather than queued — important on mobile).
 */
class FrameCursor {
  private sinkPromise: Promise<VideoSampleSink | null>;
  private current: VideoSample | null = null;
  private busy = false;
  private pending: number | null = null;

  constructor(asset: MediaAsset) {
    this.sinkPromise = createVideoSink(asset);
  }

  request(sourceSec: number): void {
    if (this.busy) {
      this.pending = sourceSec;
      return;
    }
    this.busy = true;
    void this.fetch(sourceSec);
  }

  private async fetch(sourceSec: number): Promise<void> {
    try {
      const sink = await this.sinkPromise;
      if (sink) {
        const sample = await sink.getSample(Math.max(0, sourceSec));
        if (sample) {
          this.current?.close();
          this.current = sample;
        }
      }
    } catch {
      // Decode errors surface as a stale frame; playback keeps going.
    } finally {
      this.busy = false;
      if (this.pending !== null) {
        const next = this.pending;
        this.pending = null;
        this.request(next);
      }
    }
  }

  get sample(): VideoSample | null {
    return this.current;
  }

  dispose(): void {
    this.current?.close();
    this.current = null;
  }
}

/**
 * Real-time preview: a rAF loop draws visible video frames on the canvas,
 * audio plays through a Web Audio graph. Entirely separate from the export pipeline.
 */
export class PlaybackEngine {
  private ctx: CanvasRenderingContext2D;
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private cursors = new Map<string, FrameCursor>();
  private scheduled: ScheduledSource[] = [];
  private audioBuffers = new Map<string, AudioBuffer | null>();
  private audioDirty = false;
  private raf = 0;
  private disposed = false;

  private wasPlaying = false;
  private lastSeekVersion: number;
  private lastProject: Project;
  private anchorCtxTime = 0;
  private anchorMediaMs = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
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
    void this.audioCtx?.close();
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

    // Kick decoding for any asset we don't have a buffer for yet.
    for (const track of state.project.tracks) {
      for (const clip of track.clips) {
        const asset = state.assets[clip.assetId];
        if (asset?.hasAudio && !this.audioBuffers.has(asset.id)) {
          this.audioBuffers.set(asset.id, null);
          void getAudioBuffer(asset).then((buffer) => {
            this.audioBuffers.set(asset.id, buffer);
            if (buffer) this.audioDirty = true;
          });
        }
      }
    }

    const startCtx = this.audioCtx.currentTime + 0.03;
    this.anchorCtxTime = startCtx;
    this.anchorMediaMs = fromMs;
    this.scheduled = scheduleProjectAudio(
      this.audioCtx,
      this.masterGain,
      state.project,
      (assetId) => this.audioBuffers.get(assetId) ?? null,
      fromMs,
      startCtx,
    );
  }

  private stopAudio(): void {
    stopScheduled(this.scheduled);
    this.scheduled = [];
  }

  private playbackTimeMs(state: EditorState): number {
    if (this.wasPlaying && this.audioCtx) {
      return this.anchorMediaMs + Math.max(0, this.audioCtx.currentTime - this.anchorCtxTime) * 1000;
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

    if (state.project !== this.lastProject) {
      this.lastProject = state.project;
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
      if (t >= duration) {
        t = duration;
        this.wasPlaying = false;
        this.stopAudio();
        state.setPlaying(false);
      }
      state.setCurrentTimeFromEngine(t);
    }

    this.draw(state, t);
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(state: EditorState, tMs: number): void {
    const { width, height } = outputDimensions(state.project.aspectRatio);
    // Preview renders at half resolution — plenty for on-screen display.
    const w = width / 2;
    const h = height / 2;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);

    // Track order defines z-order: the last video track draws on top.
    for (const track of state.project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      const clip = topClipAt(track.clips, tMs);
      if (!clip) continue;
      const asset = state.assets[clip.assetId];
      if (!asset) continue;

      let cursor = this.cursors.get(clip.id);
      if (!cursor) {
        cursor = new FrameCursor(asset);
        this.cursors.set(clip.id, cursor);
      }
      cursor.request(timelineToSourceMs(clip, tMs) / 1000);
      const sample = cursor.sample;
      if (sample) drawClipSample(this.ctx, sample, clip, w, h, tMs);
    }
  }

  private pruneCursors(project: Project): void {
    const liveIds = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) liveIds.add(clip.id);
    }
    for (const [clipId, cursor] of this.cursors) {
      if (!liveIds.has(clipId)) {
        cursor.dispose();
        this.cursors.delete(clipId);
      }
    }
  }
}
