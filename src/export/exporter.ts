import { LoopRegion, MediaAsset, Project } from '../types';
import { clipEndMs, delegatedLinkIds, projectDurationMs } from '../model';
import { AUDIO_SAMPLE_RATE } from '../app/config';
import { t } from '../i18n';
import { audioKey, getAudioBuffer } from '../media/mediaCache';
import { decodeImageFile } from '../media/stillImage';
import { scheduleProjectAudio } from '../preview/audioMix';
import { ExportPreset, exportFileName, resolveMp4Preset } from './presets';
import { ExportErrorCode, ExportRequest, WorkerReply } from './protocol';

export interface ExportHandle {
  promise: Promise<{ blob: Blob; filename: string }>;
  cancel: () => void;
}

/** The worker speaks in codes; the main thread owns the locale and the wording. */
const ERROR_KEYS = {
  noAudibleAudio: 'errors.export.noAudibleAudio',
  videoEncoderUnsupported: 'errors.export.videoEncoderUnsupported',
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
  // Cancellation settles the promise immediately: terminating the worker kills
  // its onmessage path, which would otherwise leave the promise pending forever.
  let rejectCanceled: (e: Error) => void = () => {};
  const cancelation = new Promise<never>((_, reject) => {
    rejectCanceled = reject;
  });
  // Settles the in-flight worker-reply promise on cancel: terminate() alone kills
  // onmessage/onerror, so without this the inner promise (and the whole `run`
  // closure it retains: project, files, audio buffers) would leak on every cancel.
  let rejectWorkerReply: ((e: Error) => void) | null = null;

  const run = (async () => {
    const projectMs = projectDurationMs(project);
    if (projectMs <= 0) throw new Error(t('errors.export.emptyProject'));

    const startMs = region ? Math.max(0, Math.min(region.startMs, projectMs)) : 0;
    const durationMs = (region ? Math.min(region.endMs, projectMs) : projectMs) - startMs;
    if (durationMs <= 0) {
      throw new Error(t('errors.export.emptyRegion'));
    }

    onProgress(0.02);
    const audio = await renderAudioMix(project, assets, startMs, durationMs);
    if (canceled) throw new Error(t('errors.export.canceled'));
    onProgress(0.1);
    if (preset.kind === 'mp3' && !audio) {
      throw new Error(t(ERROR_KEYS.noAudibleAudio));
    }

    // A disconnected source would crash the worker mid-render (or silently drop
    // audio from the mp3 mix) when it reads the stale File: refuse upfront with
    // a clear message. Cheap scan, so it runs for every preset.
    const disconnected = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const asset = assets[clip.assetId];
        if (asset?.disconnected) disconnected.add(asset.file.name);
      }
    }
    if (disconnected.size > 0) {
      throw new Error(
        t('errors.export.disconnectedSources', { names: [...disconnected].join(', ') }),
      );
    }

    // Adapt frame rate (and, with it, bitrate) to the project's source footage
    // right before encoding, so the worker receives the exact settings to use.
    const resolvedPreset =
      preset.kind === 'mp4' ? resolveMp4Preset(preset, project, assets) : preset;

    // Only the video path needs source files and rasterized stills; an mp3
    // export renders entirely from the already-mixed audio, so gathering (and
    // GPU-decoding every still) for it is pure waste.
    const files: Record<string, File> = {};
    const stills: Record<string, ImageBitmap> = {};
    if (resolvedPreset.kind === 'mp4') {
      try {
        for (const track of project.tracks) {
          for (const clip of track.clips) {
            if (canceled) throw new Error(t('errors.export.canceled'));
            const asset = assets[clip.assetId];
            if (!asset) continue;
            files[asset.id] = asset.file;
            // Stills are rasterized here (SVG needs the DOM, unavailable in the
            // worker) and transferred as bitmaps. A still that fails to decode is
            // skipped: its clips render nothing rather than killing the export.
            if (asset.kind === 'image' && !(asset.id in stills)) {
              try {
                stills[asset.id] = await decodeImageFile(asset.file);
              } catch {
                // Fall through - the worker simply has no bitmap for this asset.
              }
            }
          }
        }
        if (canceled) throw new Error(t('errors.export.canceled'));
      } catch (err) {
        // Release every bitmap decoded before the abort - they are GPU-backed
        // and are otherwise only ever freed by being transferred to the worker,
        // so a cancel here would leak one per still, every attempt.
        for (const bitmap of Object.values(stills)) bitmap.close();
        throw err;
      }
    }

    worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
    const request: ExportRequest = {
      type: 'export',
      project,
      files,
      stills,
      preset: resolvedPreset,
      startMs,
      durationMs,
      audio,
    };

    const buffer = await new Promise<{ buffer: ArrayBuffer; mime: string }>((resolve, reject) => {
      rejectWorkerReply = reject;
      worker!.onmessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg.type === 'progress') onProgress(0.1 + msg.value * 0.9);
        else if (msg.type === 'done') resolve({ buffer: msg.buffer, mime: msg.mime });
        else if (msg.type === 'error') reject(new Error(t(ERROR_KEYS[msg.code])));
        else reject(crashError(msg.detail));
      };
      worker!.onerror = (e) => reject(crashError(e.message));
      const transfer: Transferable[] = audio
        ? audio.channels.map((c) => c.buffer as ArrayBuffer)
        : [];
      transfer.push(...Object.values(stills));
      worker!.postMessage(request, transfer);
    });
    rejectWorkerReply = null;

    onProgress(1);
    return { blob: new Blob([buffer.buffer], { type: buffer.mime }), filename: exportFileName(preset) };
  })();

  const promise = Promise.race([run, cancelation]).finally(() => {
    worker?.terminate();
    worker = null;
  });
  // The raced-out branch must not surface as an unhandled rejection.
  run.catch(() => {});

  return {
    promise,
    cancel: () => {
      canceled = true;
      // Settle the inner worker-reply promise before terminating: terminate()
      // kills the message handlers, so `run` would otherwise hang and leak its
      // closure. Both rejections carry the same "canceled" message.
      rejectWorkerReply?.(new Error(t('errors.export.canceled')));
      rejectWorkerReply = null;
      worker?.terminate();
      worker = null;
      rejectCanceled(new Error(t('errors.export.canceled')));
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

  const delegated = delegatedLinkIds(project);
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      // A linked video clip delegates its sound to its audio partners: the mix
      // never schedules it, so don't decode its track (twice) nor let it count
      // as audible (it would force a silent AAC track into the file).
      if (track.kind === 'video' && clip.linkId && delegated.has(clip.linkId)) continue;
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
