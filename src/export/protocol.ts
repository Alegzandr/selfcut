import { Project } from '../types';
import { ExportPreset } from './presets';

/** Messages between the main thread and the export worker. */

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
  /** Pre-rendered audio mix (OfflineAudioContext runs on the main thread only). */
  audio: { channels: Float32Array[]; sampleRate: number } | null;
}

/**
 * Business failures the worker can report. The worker runs in its own bundle
 * and knows nothing about the user locale, so it never sends a human message:
 * it sends a code, and the main thread turns it into a translated string.
 */
export type ExportErrorCode = 'noAudibleAudio';

export type WorkerReply =
  | { type: 'progress'; value: number }
  | { type: 'done'; buffer: ArrayBuffer; mime: string }
  | { type: 'error'; code: ExportErrorCode }
  /** Anything the worker did not expect: not translatable, kept for diagnosis. */
  | { type: 'crash'; detail: string };
