import { MediaAsset, Project, clipEndMs, projectDurationMs } from '../types';
import { AUDIO_SAMPLE_RATE } from '../app/config';
import { getAudioBuffer } from '../media/mediaCache';
import { scheduleProjectAudio } from '../preview/audioMix';
import { ExportPreset, exportFileName } from './presets';
import { ExportRequest, WorkerReply } from './protocol';

export interface ExportHandle {
  promise: Promise<{ blob: Blob; filename: string }>;
  cancel: () => void;
}

/**
 * Orchestrates an export: renders the audio mix offline on the main thread
 * (OfflineAudioContext is unavailable in workers), then hands everything to
 * the export worker which decodes, composites and encodes frame by frame.
 */
export function startExport(
  project: Project,
  assets: Record<string, MediaAsset>,
  preset: ExportPreset,
  onProgress: (value: number) => void,
): ExportHandle {
  let worker: Worker | null = null;
  let canceled = false;

  const promise = (async () => {
    const durationMs = projectDurationMs(project);
    if (durationMs <= 0) throw new Error('The project is empty — add clips to the timeline first.');

    onProgress(0.01);
    const audio = await renderAudioMix(project, assets, durationMs);
    if (canceled) throw new Error('Export canceled.');
    if (preset.kind === 'mp3' && !audio) {
      throw new Error('Nothing to export as MP3: no audible audio in the project.');
    }

    const files: Record<string, File> = {};
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const asset = assets[clip.assetId];
        if (asset) files[asset.id] = asset.file;
      }
    }

    worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
    const request: ExportRequest = { type: 'export', project, files, preset, durationMs, audio };

    const buffer = await new Promise<{ buffer: ArrayBuffer; mime: string }>((resolve, reject) => {
      worker!.onmessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg.type === 'progress') onProgress(0.02 + msg.value * 0.98);
        else if (msg.type === 'done') resolve({ buffer: msg.buffer, mime: msg.mime });
        else reject(new Error(msg.message));
      };
      worker!.onerror = (e) => reject(new Error(e.message || 'Export worker crashed.'));
      const transfer = audio ? audio.channels.map((c) => c.buffer as ArrayBuffer) : [];
      worker!.postMessage(request, transfer);
    });

    onProgress(1);
    return { blob: new Blob([buffer.buffer], { type: buffer.mime }), filename: exportFileName(preset) };
  })().finally(() => {
    worker?.terminate();
    worker = null;
  });

  return {
    promise,
    cancel: () => {
      canceled = true;
      worker?.terminate();
      worker = null;
    },
  };
}

/** Render the full project audio mix with an OfflineAudioContext. */
async function renderAudioMix(
  project: Project,
  assets: Record<string, MediaAsset>,
  durationMs: number,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const buffers = new Map<string, AudioBuffer | null>();
  let hasAudibleClip = false;

  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.volume <= 0 || clipEndMs(clip) <= 0) continue;
      const asset = assets[clip.assetId];
      if (!asset?.hasAudio) continue;
      if (!buffers.has(asset.id)) {
        buffers.set(asset.id, await getAudioBuffer(asset));
      }
      if (buffers.get(asset.id)) hasAudibleClip = true;
    }
  }
  if (!hasAudibleClip) return null;

  const length = Math.max(1, Math.ceil((durationMs / 1000) * AUDIO_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, AUDIO_SAMPLE_RATE);
  scheduleProjectAudio(ctx, ctx.destination, project, (id) => buffers.get(id) ?? null, 0, 0);
  const rendered = await ctx.startRendering();

  return {
    channels: [rendered.getChannelData(0), rendered.getChannelData(1)],
    sampleRate: AUDIO_SAMPLE_RATE,
  };
}

/** Trigger a browser download for the produced file. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
