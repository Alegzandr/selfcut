import { LoopRegion, MediaAsset, Project } from '../types';
import { clipEndMs, projectDurationMs } from '../model';
import { AUDIO_SAMPLE_RATE } from '../app/config';
import { t } from '../i18n';
import { audioKey, getAudioBuffer } from '../media/mediaCache';
import { scheduleProjectAudio } from '../preview/audioMix';
import { ExportPreset, exportFileName } from './presets';
import { ExportErrorCode, ExportRequest, WorkerReply } from './protocol';

export interface ExportHandle {
  promise: Promise<{ blob: Blob; filename: string }>;
  cancel: () => void;
}

/** The worker speaks in codes; the main thread owns the locale and the wording. */
const ERROR_KEYS = {
  noAudibleAudio: 'errors.export.noAudibleAudio',
} as const satisfies Record<ExportErrorCode, string>;

/**
 * A worker crash is not a business failure: the browser hands us an untranslated
 * native message, which we keep as a diagnostic rather than swallow.
 */
function crashError(detail: string): Error {
  return new Error(
    detail ? t('errors.export.workerCrashedDetail', { detail }) : t('errors.export.workerCrashed'),
  );
}

/**
 * Orchestrates an export: renders the audio mix offline on the main thread
 * (OfflineAudioContext is unavailable in workers), then hands everything to
 * the export worker which decodes, composites and encodes frame by frame.
 * `region` (the timeline selection) restricts the render to that span.
 */
export function startExport(
  project: Project,
  assets: Record<string, MediaAsset>,
  preset: ExportPreset,
  onProgress: (value: number) => void,
  region?: LoopRegion | null,
): ExportHandle {
  let worker: Worker | null = null;
  let canceled = false;

  const promise = (async () => {
    const projectMs = projectDurationMs(project);
    if (projectMs <= 0) throw new Error(t('errors.export.emptyProject'));

    const startMs = region ? Math.max(0, Math.min(region.startMs, projectMs)) : 0;
    const durationMs = (region ? Math.min(region.endMs, projectMs) : projectMs) - startMs;
    if (durationMs <= 0) {
      throw new Error(t('errors.export.emptyRegion'));
    }

    onProgress(0.01);
    const audio = await renderAudioMix(project, assets, startMs, durationMs);
    if (canceled) throw new Error(t('errors.export.canceled'));
    if (preset.kind === 'mp3' && !audio) {
      throw new Error(t(ERROR_KEYS.noAudibleAudio));
    }

    const files: Record<string, File> = {};
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const asset = assets[clip.assetId];
        if (asset) files[asset.id] = asset.file;
      }
    }

    worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
    const request: ExportRequest = {
      type: 'export',
      project,
      files,
      preset,
      startMs,
      durationMs,
      audio,
    };

    const buffer = await new Promise<{ buffer: ArrayBuffer; mime: string }>((resolve, reject) => {
      worker!.onmessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg.type === 'progress') onProgress(0.02 + msg.value * 0.98);
        else if (msg.type === 'done') resolve({ buffer: msg.buffer, mime: msg.mime });
        else if (msg.type === 'error') reject(new Error(t(ERROR_KEYS[msg.code])));
        else reject(crashError(msg.detail));
      };
      worker!.onerror = (e) => reject(crashError(e.message));
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

/** Render the exported span of the project audio mix with an OfflineAudioContext. */
async function renderAudioMix(
  project: Project,
  assets: Record<string, MediaAsset>,
  startMs: number,
  durationMs: number,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const buffers = new Map<string, AudioBuffer | null>();
  let hasAudibleClip = false;

  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      // Clips ending before the span, or starting after it, are silent here.
      if (clip.volume <= 0 || clipEndMs(clip) <= startMs) continue;
      if (clip.timelineStartMs >= startMs + durationMs) continue;
      const asset = assets[clip.assetId];
      if (!asset?.hasAudio) continue;
      const key = audioKey(asset.id, clip.audioTrackIndex);
      if (!buffers.has(key)) {
        buffers.set(key, await getAudioBuffer(asset, clip.audioTrackIndex));
      }
      if (buffers.get(key)) hasAudibleClip = true;
    }
  }
  if (!hasAudibleClip) return null;

  const length = Math.max(1, Math.ceil((durationMs / 1000) * AUDIO_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, AUDIO_SAMPLE_RATE);
  scheduleProjectAudio(
    ctx,
    ctx.destination,
    project,
    (id, audioTrackIndex) => buffers.get(audioKey(id, audioTrackIndex)) ?? null,
    startMs,
    0,
  );
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
