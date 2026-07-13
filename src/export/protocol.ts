import { Project } from '../types';
import { ExportPreset } from './presets';

/** Messages between the main thread and the export worker. */

export interface ExportRequest {
  type: 'export';
  project: Project;
  /** assetId → File, for every asset referenced by the project. */
  files: Record<string, File>;
  preset: ExportPreset;
  durationMs: number;
  /** Pre-rendered audio mix (OfflineAudioContext runs on the main thread only). */
  audio: { channels: Float32Array[]; sampleRate: number } | null;
}

export type WorkerReply =
  | { type: 'progress'; value: number }
  | { type: 'done'; buffer: ArrayBuffer; mime: string }
  | { type: 'error'; message: string };
