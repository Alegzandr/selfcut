import { LoopRegion, MediaAsset, Project } from '../types';
import { clipEndMs, delegatedLinkIds, projectDurationMs } from '../model';
import { AUDIO_SAMPLE_RATE } from '../app/config';
import { t } from '../i18n';
import { audioKey, getAudioBuffer } from '../media/mediaCache';
import { decodeImageFile } from '../media/stillImage';
import { scheduleProjectAudio } from '../preview/audioMix';
import { openExportScratch, readExportScratch } from '../lib/opfs';
import { flushProjectSave } from '../lib/persistence';
import { ExportPreset, exportFileName, resolveMp4Preset } from './presets';
import { ExportErrorCode, ExportRequest, WorkerReply } from './protocol';

export interface ExportHandle {
  /**
   * `blob` is null when the render streamed straight into a file the user
   * picked: the file is already on disk, so there is nothing left to download.
   */
  promise: Promise<{ blob: Blob | null; filename: string }>;
  cancel: () => void;
}

/**
 * The user backed out (dismissed the save picker). Distinct from a failure so
 * the sheet returns to its idle state instead of showing an error screen.
 */
export class ExportCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportCanceledError';
  }
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/**
 * Ask where to save, so the worker can mux straight into that file instead of
 * building the whole output in memory.
 *
 * Must be reached without awaiting anything first: the picker needs transient
 * user activation, which the click that started the export only carries until
 * the first suspension point. Returns null when the browser has no File System
 * Access API (Firefox, Safari), which selects the buffered fallback path.
 */
async function pickExportFile(filename: string, mime: string): Promise<FileSystemFileHandle | null> {
  const show = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (!show) return null;
  const ext = filename.slice(filename.lastIndexOf('.'));
  try {
    return await show({
      suggestedName: filename,
      types: [{ description: t('export.fileType'), accept: { [mime]: [ext] } }],
    });
  } catch (err) {
    // Dismissing the picker aborts the export; anything else falls back to the
    // scratch path rather than blocking the render outright.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ExportCanceledError(t('errors.export.canceled'));
    }
    // Worth a line: this is the difference between streaming to disk and
    // building the file in memory, and it used to fail silently.
    console.warn('[export] save picker unavailable, falling back to scratch storage:', err);
    return null;
  }
}

/**
 * Ceiling on what the last-resort in-memory render may produce.
 *
 * Only reached when the browser offers neither a save picker nor OPFS. The
 * buffer is one contiguous allocation that doubles as it grows, so the peak is
 * about twice the figure below - past this the allocation fails and the browser
 * reports it as a raw "Array buffer allocation failed" with no hint that the
 * length or the preset was the problem. Refusing up front says so instead.
 */
const MAX_IN_MEMORY_EXPORT_BYTES = 1024 * 1024 * 1024;

/** Rough size of the output, from the bitrates the preset is about to encode at. */
function estimatedOutputBytes(preset: ExportPreset, durationMs: number): number {
  const videoBitrate = preset.kind === 'mp4' ? preset.videoBitrate : 0;
  return ((videoBitrate + preset.audioBitrate) / 8) * (durationMs / 1000);
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
    // Get the timeline on disk before the heaviest thing the app does starts.
    // A render holds decoded frames, an encoder and the whole mix at once, so
    // it is the likeliest moment for the tab to be killed - and losing the cut
    // that was being exported is the worst possible way to find that out.
    // Synchronous, so it does not cost the picker its user activation.
    flushProjectSave();

    const projectMs = projectDurationMs(project);
    if (projectMs <= 0) throw new Error(t('errors.export.emptyProject'));

    const startMs = region ? Math.max(0, Math.min(region.startMs, projectMs)) : 0;
    const durationMs = (region ? Math.min(region.endMs, projectMs) : projectMs) - startMs;
    if (durationMs <= 0) {
      throw new Error(t('errors.export.emptyRegion'));
    }

    // A disconnected source would crash the worker mid-render (or silently drop
    // audio from the mp3 mix) when it reads the stale File: refuse upfront with
    // a clear message. Cheap scan, so it runs for every preset. Checked before
    // the save picker so a doomed export never asks where to put its output.
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

    // First await of the run: everything above is synchronous so the picker
    // still runs under the activation of the click that started the export.
    const filename = exportFileName(preset);
    let fileHandle = await pickExportFile(
      filename,
      preset.kind === 'mp3' ? 'audio/mpeg' : 'video/mp4',
    );

    // No file to write into (Firefox and Safari have no save picker, and the
    // picker can be refused even where it exists): render into origin-private
    // scratch storage rather than into memory. The render streams either way,
    // so only where the bytes land changes - and the user still gets the same
    // download at the end, just from disk instead of from a 6 GB buffer.
    let scratch: FileSystemFileHandle | null = null;
    if (!fileHandle) {
      const opened = await openExportScratch(filename);
      if (opened) {
        scratch = opened.handle;
        fileHandle = opened.handle;
      } else if (estimatedOutputBytes(preset, durationMs) > MAX_IN_MEMORY_EXPORT_BYTES) {
        // Neither a picked file nor scratch space: the only path left builds the
        // whole file in RAM, and this one would not fit.
        throw new Error(t('errors.export.tooLargeForMemory'));
      }
    }

    onProgress(0.02);
    const audio = await renderAudioMix(project, assets, startMs, durationMs);
    if (canceled) throw new Error(t('errors.export.canceled'));
    onProgress(0.1);
    if (preset.kind === 'mp3' && !audio) {
      throw new Error(t(ERROR_KEYS.noAudibleAudio));
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
      fileHandle,
    };

    const buffer = await new Promise<{ buffer: ArrayBuffer | null; mime: string }>((resolve, reject) => {
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
    // Three destinations, one return shape. A render into the file the user
    // picked is already where they wanted it (blob: null, nothing to
    // download); a scratch render is on disk too, but privately, so it is
    // handed back as a File the download anchor can point at without ever
    // loading it into memory; only the in-memory last resort materializes a
    // Blob from a buffer.
    if (scratch) return { blob: await readExportScratch(scratch), filename };
    return {
      blob: buffer.buffer ? new Blob([buffer.buffer], { type: buffer.mime }) : null,
      filename,
    };
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
  const pending: Promise<void>[] = [];
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
      // Kicked off, not awaited: decoding one source at a time serialized the
      // whole pre-roll of an export, and these decodes are independent.
      if (!buffers.has(key)) {
        buffers.set(key, null);
        pending.push(
          getAudioBuffer(asset, clip.audioTrackIndex).then((buffer) => {
            buffers.set(key, buffer);
          }),
        );
      }
      // An asset with an audio track counts as audible here; a source that
      // turns out to decode to nothing is filtered out below.
      hasAudibleClip = true;
    }
  }
  if (!hasAudibleClip) return null;
  await Promise.all(pending);
  if (![...buffers.values()].some(Boolean)) return null;

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
