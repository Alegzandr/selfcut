import { Project } from '../types';
import type { PerfSnapshot } from '../perf/probe';
import { ExportPreset } from './presets';

/** Messages between the main thread and the export worker. */

/** The encoder configuration a render actually ran with. */
export interface ExportEncoderInfo {
  codec: string;
  /** What the browser chose, not what was asked for. */
  hardwareAcceleration: string;
  width: number;
  height: number;
  bitrate: number;
}

/** Everything the worker needs to know about the mix before it has any of it. */
export interface AudioMixInfo {
  sampleRate: number;
  channelCount: number;
  /** Frames per channel over the whole exported span. */
  totalFrames: number;
}

/**
 * How many frames of mix the worker pulls per request.
 *
 * Five seconds of stereo 48 kHz is 1.9 MB, which is the peak the mix now costs
 * however long the timeline is. Small enough to be nothing, large enough that
 * the round trip per chunk is lost in the noise of encoding five seconds of
 * audio.
 */
export const AUDIO_CHUNK_FRAMES = 5 * 48000;

/** Main thread → worker: the rendered mix for a span the worker asked for. */
export interface AudioChunkMessage {
  type: 'audioChunk';
  /** Frame offset into the exported span, matching the request. */
  offset: number;
  /** One Float32Array per channel, `frames` long. Transferred, not copied. */
  channels: Float32Array[];
}

/** Main thread → worker: rendering that chunk failed; give up on the audio. */
export interface AudioFailedMessage {
  type: 'audioFailed';
  offset: number;
}

export type MainToWorker = ExportRequest | AudioChunkMessage | AudioFailedMessage;

export interface ExportRequest {
  type: 'export';
  project: Project;
  /** assetId → File, for every asset referenced by the project. */
  files: Record<string, File>;
  /**
   * assetId → rasterized bitmap, for every still-image asset on the timeline.
   * Rasterized on the main thread (SVG needs the DOM) and transferred.
   */
  stills: Record<string, ImageBitmap>;
  preset: ExportPreset;
  /** First timeline ms to render (loop region in point, 0 for the whole project). */
  startMs: number;
  /** Length of the rendered span, from startMs. */
  durationMs: number;
  /**
   * Shape of the audio mix, not the mix itself.
   *
   * `OfflineAudioContext` only exists on the main thread, so the mix has to be
   * rendered there - but it does NOT have to be rendered all at once. An hour
   * of stereo 48 kHz is 690 MB of Float32, allocated in one block, held for the
   * entire video render, and then transferred. The worker now pulls the mix a
   * few seconds at a time (`needAudio` / `audioChunk`), so what is live at any
   * moment is one chunk, whatever the length of the cut.
   */
  audio: AudioMixInfo | null;
  /**
   * Destination picked by the user, when the browser supports the File System
   * Access API. The worker then muxes straight into the file instead of holding
   * the whole output in memory: a 5 min 4K render is ~2 GB, which the buffered
   * path had to allocate contiguously and then copy again into a Blob.
   * Null on browsers without the API - the buffered path stays the fallback.
   */
  fileHandle: FileSystemFileHandle | null;
  /**
   * Turn the worker's frame instrumentation on for this render. Off by default:
   * the probe costs nothing when disabled, and an export the user started is
   * not the moment to spend anything at all on measuring it. The perf HUD and
   * the e2e budget suite are what set it.
   */
  measure?: boolean;
  /**
   * Force the single-worker render. Set by the main thread when a fanned-out
   * attempt reported `segmentMismatch`, which means two identically configured
   * encoders produced different parameter sets and their output cannot be
   * concatenated. Should never happen; retrying serially is what makes it a
   * slow export rather than a broken file.
   */
  noParallel?: boolean;
  /**
   * Ask the browser for the software encoder rather than letting it choose.
   *
   * Set by the main thread after an attempt reported `encoderStalled`. The
   * browser's own pick is right nearly always and is several times faster, so
   * this is never the first thing tried - but when the encoder it picked
   * accepts the configuration and then emits nothing, it is the only thing that
   * turns a render that hangs for ever into a render that finishes.
   */
  preferSoftwareEncoder?: boolean;
}

/**
 * Business failures the worker can report. The worker runs in its own bundle
 * and knows nothing about the user locale, so it never sends a human message:
 * it sends a code, and the main thread turns it into a translated string.
 */
export type ExportErrorCode =
  | 'noAudibleAudio'
  | 'videoEncoderUnsupported'
  | 'segmentMismatch'
  /**
   * The encoder accepted the configuration and then stopped producing packets.
   * Acted on rather than shown: the main thread re-runs the render on the
   * software encoder, and only a second stall reaches the user.
   */
  | 'encoderStalled';

export type WorkerReply =
  | { type: 'progress'; value: number }
  /**
   * Worker → main thread: render and send me `frames` of mix starting at
   * `offset`. One request in flight at a time, so the main thread never renders
   * ahead of what the encoder can absorb.
   */
  | { type: 'needAudio'; offset: number; frames: number }
  /**
   * A snapshot of the frame the render is on, for the preview monitor. Sent a
   * few times a second and transferred, never copied: it is a picture of
   * progress, not a playback stream. The main thread owns the bitmap from here
   * and is what closes it.
   */
  | { type: 'previewFrame'; bitmap: ImageBitmap; timeMs: number }
  /** `buffer` is null when the output went straight to the user's file. */
  | { type: 'done'; buffer: ArrayBuffer | null; mime: string }
  | { type: 'error'; code: ExportErrorCode }
  /** Frame breakdown of the finished render, when `measure` was set. */
  | { type: 'perf'; snapshot: PerfSnapshot }
  /**
   * The encoder configuration the browser settled on. Reported because whether
   * a render is running on hardware is the single largest factor in how long it
   * takes, and nothing anywhere used to say which one happened.
   */
  | ({ type: 'encoder' } & ExportEncoderInfo)
  /** Anything the worker did not expect: not translatable, kept for diagnosis. */
  | { type: 'crash'; detail: string };
