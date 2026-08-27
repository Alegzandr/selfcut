import { Clip, LoopRegion, MediaAsset, Project } from '../types';
import { clipEndMs, delegatedLinkIds, projectDurationMs } from '../model';
import { AUDIO_SAMPLE_RATE } from '../app/config';
import { t } from '../i18n';
import { audioKey, getAudioRange } from '../media/mediaCache';
import { AudioSegment, segmentIndexes } from '../media/audioSegments';
import { decodeImageFile } from '../media/stillImage';
import { scheduleProjectAudio } from '../preview/audioMix';
import { firstUncloneable } from '../lib/cloneable';
import { openExportScratch, readExportScratch } from '../lib/opfs';
import { flushProjectSave } from '../lib/persistence';
import { ExportPreset, exportFileName, resolveMp4Preset } from './presets';
import { clearRenderPreview, publishRenderFrame } from './renderPreviewBus';
import { nextAttempt, retryReason, type ExportAttempt } from './retryPlan';
import { perfEnabled, type PerfSnapshot } from '../perf/probe';
import {
  type AudioMixInfo,
  type ExportEncoderInfo,
  ExportErrorCode,
  ExportRequest,
  type ExportSink,
  WorkerReply,
} from './protocol';

/**
 * Why a render started over.
 *
 * Only ever reported for the encoder fallbacks, because those are the ones the
 * user watches happen: the bar goes back to the beginning and the render takes
 * longer than the one that was abandoned. Told what it is, that is a machine
 * being worked around; untold, it is the app losing several minutes of work for
 * no stated reason.
 */
export type ExportFallback = 'oneEncoder' | 'softwareEncoder';

/** Rarely-used knobs on a render. */
export interface ExportOptions {
  /**
   * Render on a single worker instead of fanning out.
   *
   * The fanned-out path is the default because it is several times faster on
   * any machine with cores to spare, but it holds one encoder session and a
   * slice buffer per worker: forcing it off is the escape hatch for a machine
   * that cannot afford that, and the control the perf suite uses to compare the
   * two paths on identical input.
   */
  noParallel?: boolean;
  /**
   * Called when the render is about to be re-run on gentler terms. The progress
   * that has been reported so far is abandoned at that point, so this is what
   * lets the UI explain a bar that just went backwards.
   */
  onFallback?: (reason: ExportFallback) => void;
  /**
   * Encode at the preset's full cadence even where the footage cannot fill it.
   * The sheet's checkbox; see `ResolveOptions` in `presets`.
   */
  forceMaxFps?: boolean;
}

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
  // Handled by retrying serially rather than shown, but a key is still needed:
  // if the retry itself somehow reports it, the user gets a sentence and not a
  // blank error.
  segmentMismatch: 'errors.export.workerCrashed',
  // Only ever shown once every fallback has stalled too: the render is retried
  // on one encoder, then on the software one, without the user being told
  // anything. Reaching this sentence means the encoder answers nothing at all.
  encoderStalled: 'errors.export.encoderStalled',
  // Retried on terms that copy less before it is ever shown; the sentence names
  // the value the browser refused, which is the only part worth reporting.
  cannotClone: 'errors.export.cannotClone',
} as const satisfies Record<ExportErrorCode, string>;

/**
 * A failure the worker classified. Carries the code as well as the message, so
 * `segmentMismatch` can be acted on instead of merely displayed.
 */
class ExportWorkerError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    params?: Record<string, string>,
  ) {
    super(t(ERROR_KEYS[code], params));
    this.name = 'ExportWorkerError';
  }
}

/**
 * A refused structured clone, whatever the engine calls it. The message differs
 * between them - Chromium says the object "could not be cloned", WebKit that it
 * "can not be cloned" - so the name is what identifies it. Anything else thrown
 * by `postMessage` is not this and is left to surface as itself.
 */
function isDataCloneError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'DataCloneError';
}

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
  options?: ExportOptions,
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
  /**
   * Set once the export has settled, so a `previewFrame` already queued when
   * the worker was terminated cannot leave the monitor frozen on a render that
   * is over. Its bitmap is closed instead of published.
   */
  let settled = false;

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
    const picked = await pickExportFile(
      filename,
      preset.kind === 'mp3' ? 'audio/mpeg' : 'video/mp4',
    );
    let sink: ExportSink | null = picked ? { kind: 'picked', handle: picked } : null;

    // No file to write into (Firefox and Safari have no save picker, and the
    // picker can be refused even where it exists): render into origin-private
    // scratch storage rather than into memory. The render streams either way,
    // so only where the bytes land changes - and the user still gets the same
    // download at the end, just from disk instead of from a 6 GB buffer.
    //
    // The scratch file goes to the worker as its NAME. WebKit will not put a
    // `FileSystemFileHandle` through `postMessage` - it refuses the whole
    // message - so an export on any iOS browser died here, before a frame was
    // drawn, with the browser's own "The object can not be cloned."
    let scratch: FileSystemFileHandle | null = null;
    if (!sink) {
      const opened = await openExportScratch(filename);
      if (opened) {
        scratch = opened.handle;
        sink = { kind: 'scratch', name: opened.name };
      } else if (estimatedOutputBytes(preset, durationMs) > MAX_IN_MEMORY_EXPORT_BYTES) {
        // Neither a picked file nor scratch space: the only path left builds the
        // whole file in RAM, and this one would not fit.
        throw new Error(t('errors.export.tooLargeForMemory'));
      }
    }

    onProgress(0.02);
    // Works out the mix's shape; the samples themselves - and the source
    // segments they read - are produced slice by slice, as the worker asks.
    const mix = prepareAudioMix(project, assets, startMs, durationMs);
    if (canceled) throw new Error(t('errors.export.canceled'));
    onProgress(0.1);
    if (preset.kind === 'mp3' && !mix) {
      throw new Error(t(ERROR_KEYS.noAudibleAudio));
    }

    // Adapt frame rate (and, with it, bitrate) to the project's source footage
    // right before encoding, so the worker receives the exact settings to use.
    const resolvedPreset =
      preset.kind === 'mp4'
        ? resolveMp4Preset(preset, project, assets, { forceMaxFps: options?.forceMaxFps })
        : preset;

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

    /**
     * Run one render in a fresh worker.
     *
     * `stills` are CLONED rather than transferred: a transfer detaches the
     * bitmaps here, and the serial retry below needs to hand them over a second
     * time. There are at most a handful of them and they are the only thing in
     * the request that is not already shared, so the copy is cheaper than the
     * bookkeeping that would avoid it.
     */
    const runWorker = (
      attempt: ExportAttempt,
    ): Promise<{ buffer: ArrayBuffer | null; mime: string }> => {
      worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
      const request: ExportRequest = {
        type: 'export',
        project,
        files,
        stills,
        preset: resolvedPreset,
        startMs,
        durationMs,
        audio: mix?.info ?? null,
        // Dropped on a buffered attempt: it is the only part of the request
        // that is not plain data, so it is the first thing to go when the
        // browser refuses to copy the request at all.
        sink: attempt.bufferOutput ? null : sink,
        measure: perfEnabled(),
        ...(attempt.noParallel ? { noParallel: true } : {}),
        ...(attempt.preferSoftware ? { preferSoftwareEncoder: true } : {}),
      };
      return new Promise((resolve, reject) => {
        rejectWorkerReply = reject;
        worker!.onmessage = (e: MessageEvent<WorkerReply>) => {
          const msg = e.data;
          if (msg.type === 'progress') onProgress(0.1 + msg.value * 0.9);
          else if (msg.type === 'perf') lastPerf = msg.snapshot;
          else if (msg.type === 'needAudio') void serveAudio(msg.offset, msg.frames);
          // The frame the render is on, onto the preview monitor: for the whole
          // length of an export the picture is otherwise whatever still the
          // playhead was parked on, which says nothing about what is happening.
          else if (msg.type === 'previewFrame') {
            if (settled) msg.bitmap.close();
            else publishRenderFrame(msg.bitmap, msg.timeMs);
          }
          else if (msg.type === 'encoder') lastEncoder = msg;
          else if (msg.type === 'done') resolve({ buffer: msg.buffer, mime: msg.mime });
          else if (msg.type === 'error') reject(new ExportWorkerError(msg.code));
          else reject(crashError(msg.detail));
        };
        worker!.onerror = (e) => reject(crashError(e.message));
        // One slice of the mix, rendered now that the encoder is ready for it
        // and transferred (not copied) into the worker. A failure here truncates
        // the soundtrack rather than losing the whole render.
        const serveAudio = async (offset: number, frames: number): Promise<void> => {
          const target = worker;
          if (!target || !mix) return;
          try {
            const channels = await mix.render(offset, frames);
            if (worker !== target) return;
            target.postMessage(
              { type: 'audioChunk', offset, channels },
              channels.map((c) => c.buffer as ArrayBuffer),
            );
          } catch (err) {
            console.warn('[export] audio slice failed, truncating the mix:', err);
            if (worker === target) target.postMessage({ type: 'audioFailed', offset });
          }
        };
        try {
          worker!.postMessage(request);
        } catch (err) {
          // A structured clone the engine would not perform. Nothing has started
          // - so this is not a failed render, it is a request this browser will
          // not carry - and the retry plan drops what it had to copy. The value
          // it choked on is worked out here, once, and travels with the error:
          // the browser's own message names nothing at all.
          if (!isDataCloneError(err)) throw err;
          // The browser's own sentence is the fallback: an engine can refuse a
          // worker message and still put every value in it through a port, and
          // then there is no field to name - only what it said.
          const field = firstUncloneable(request) ?? String((err as Error).message);
          console.warn(`[export] this browser will not copy \`${field}\` to the worker`);
          reject(new ExportWorkerError('cannotClone', { field }));
        }
      });
    };

    /**
     * Run the render, and re-run it on less demanding terms for each failure
     * that has an answer. `nextAttempt` owns which those are, and when there is
     * nothing left to try it returns null and the failure reaches the user.
     */
    let attempt: ExportAttempt = {
      noParallel: !!options?.noParallel,
      preferSoftware: false,
      bufferOutput: false,
    };
    let buffer: { buffer: ArrayBuffer | null; mime: string };
    for (;;) {
      try {
        buffer = await runWorker(attempt);
        break;
      } catch (err) {
        if (!(err instanceof ExportWorkerError)) throw err;
        const next = nextAttempt(attempt, err.code);
        if (!next) throw err;
        console.warn(`[export] ${retryReason(err.code, next)}`);
        if (err.code === 'encoderStalled') {
          options?.onFallback?.(next.preferSoftware ? 'softwareEncoder' : 'oneEncoder');
        }
        attempt = next;
        // Cast: nothing in this function body assigns `worker`, so control-flow
        // analysis still believes it is null - `runWorker` sets it from inside a
        // closure that the analysis cannot follow.
        (worker as Worker | null)?.terminate();
        worker = null;
        // `cause` keeps the failure that was in hand when the cancel landed:
        // the user sees the cancel, and a render that gave up on itself can
        // still be traced back.
        if (canceled) throw new Error(t('errors.export.canceled'), { cause: err });
        // The new attempt walks the same ground from the start: put the bar back
        // where that attempt begins rather than let it appear to freeze at
        // whatever the abandoned render had reached.
        onProgress(0.1);
      }
    }
    rejectWorkerReply = null;
    for (const bitmap of Object.values(stills)) bitmap.close();

    onProgress(1);
    // Three destinations, one return shape. A render into the file the user
    // picked is already where they wanted it (blob: null, nothing to
    // download); a scratch render is on disk too, but privately, so it is
    // handed back as a File the download anchor can point at without ever
    // loading it into memory; only the in-memory last resort materializes a
    // Blob from a buffer.
    //
    // `bufferOutput` is what tells those last two apart. The scratch file is
    // opened before the first attempt and outlives one that never used it, so
    // an attempt that buffered would otherwise hand back that untouched file -
    // a download of nothing at all, reported as a finished export.
    if (scratch && !attempt.bufferOutput) return { blob: await readExportScratch(scratch), filename };
    return {
      blob: buffer.buffer ? new Blob([buffer.buffer], { type: buffer.mime }) : null,
      filename,
    };
  })();

  const promise = Promise.race([run, cancelation]).finally(() => {
    settled = true;
    // Done, failed or canceled alike: hand the monitor back to the playhead.
    clearRenderPreview();
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

/**
 * The audio side of an export, rendered on demand.
 *
 * The mix is produced by an `OfflineAudioContext`, which only exists on the
 * main thread. It does NOT have to exist all at once: rendering the exported
 * span in slices and handing them over as the encoder asks for them keeps the
 * peak at one slice instead of the whole timeline. An hour of stereo 48 kHz is
 * 690 MB as one block, and 1.9 MB a slice at a time.
 *
 * The sources feeding it are streamed the same way. Each slice decodes only the
 * segments its own span reads (see `audioSegments.ts`) and holds them for the
 * length of the render, so exporting an hour-long recording costs a window of
 * decoded audio rather than the whole source - which used to be 1.4 GB in one
 * allocation, and simply failed.
 *
 * Slice boundaries are exact sample counts, so nothing drifts: slice `n` starts
 * at sample `offset` and the timeline position it renders from is derived from
 * that sample, not accumulated.
 */
class AudioMixRenderer {
  constructor(
    private readonly project: Project,
    private readonly assets: Record<string, MediaAsset>,
    private readonly startMs: number,
    readonly info: AudioMixInfo,
  ) {}

  async render(offset: number, frames: number): Promise<Float32Array[]> {
    const fromMs = this.startMs + (offset / this.info.sampleRate) * 1000;
    const durationMs = (Math.max(1, frames) / this.info.sampleRate) * 1000;
    // Decoded first and held for the whole render: the scheduler reads what is
    // in hand synchronously, and a cache eviction between the decode and the
    // schedule would silently drop part of the slice.
    const held = await decodeSliceSegments(this.project, this.assets, fromMs, durationMs);

    const ctx = new OfflineAudioContext(
      this.info.channelCount,
      Math.max(1, frames),
      this.info.sampleRate,
    );
    // Seeking the mix to this slice is exactly what the preview does on every
    // scrub, so clip fades, crossfades and envelopes land at the same absolute
    // timeline positions they would in one continuous render.
    scheduleProjectAudio(
      ctx,
      ctx.destination,
      this.project,
      (assetId, audioTrackIndex, segFromMs, segToMs) => {
        const byIndex = held.get(audioKey(assetId, audioTrackIndex));
        if (!byIndex) return [];
        const out: AudioSegment[] = [];
        for (const index of segmentIndexes(segFromMs, segToMs)) {
          const segment = byIndex.get(index);
          if (segment) out.push(segment);
        }
        return out;
      },
      fromMs,
      0,
      durationMs,
    );
    const rendered = await ctx.startRendering();
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < this.info.channelCount; ch++) channels.push(rendered.getChannelData(ch));
    return channels;
  }
}

/**
 * Every clip audible in a span, with the asset it reads.
 *
 * Shared by the slice decoder and the "is there any sound at all" pass, so the
 * two can never disagree about what the mix contains - a mismatch there is
 * either a silent AAC track forced into the file or a slice missing its audio.
 */
function audibleClips(
  project: Project,
  assets: Record<string, MediaAsset>,
  startMs: number,
  durationMs: number,
): { clip: Clip; asset: MediaAsset }[] {
  const out: { clip: Clip; asset: MediaAsset }[] = [];
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
      out.push({ clip, asset });
    }
  }
  return out;
}

/**
 * Decode what one slice reads, keyed the way the scheduler asks for it.
 *
 * Sources decode concurrently - one slice waits on the slowest of them, not on
 * their sum, and the encoder is idle until this resolves.
 */
async function decodeSliceSegments(
  project: Project,
  assets: Record<string, MediaAsset>,
  fromMs: number,
  durationMs: number,
): Promise<Map<string, Map<number, AudioSegment>>> {
  const held = new Map<string, Map<number, AudioSegment>>();
  await Promise.all(
    audibleClips(project, assets, fromMs, durationMs).map(async ({ clip, asset }) => {
      const speed = clip.speed || 1;
      const windowFrom = Math.max(fromMs, clip.timelineStartMs);
      const windowTo = Math.min(fromMs + durationMs, clipEndMs(clip));
      if (windowTo <= windowFrom) return;
      const segments = await getAudioRange(
        asset,
        clip.audioTrackIndex,
        clip.sourceInMs + (windowFrom - clip.timelineStartMs) * speed,
        Math.min(clip.sourceOutMs, clip.sourceInMs + (windowTo - clip.timelineStartMs) * speed),
      );
      const key = audioKey(asset.id, clip.audioTrackIndex);
      let byIndex = held.get(key);
      if (!byIndex) held.set(key, (byIndex = new Map()));
      for (const segment of segments) byIndex.set(segment.index, segment);
    }),
  );
  return held;
}

/** Describe the mix's shape, or answer that the export has no sound in it. */
function prepareAudioMix(
  project: Project,
  assets: Record<string, MediaAsset>,
  startMs: number,
  durationMs: number,
): AudioMixRenderer | null {
  // An asset with an audio track counts as audible; a source that turns out to
  // decode to nothing renders as silence in its slices.
  if (audibleClips(project, assets, startMs, durationMs).length === 0) return null;
  const totalFrames = Math.max(1, Math.ceil((durationMs / 1000) * AUDIO_SAMPLE_RATE));
  return new AudioMixRenderer(project, assets, startMs, {
    sampleRate: AUDIO_SAMPLE_RATE,
    channelCount: 2,
    totalFrames,
  });
}

/**
 * Frame breakdown of the last measured render.
 *
 * The export runs in a worker with its own copy of the probe, so its numbers
 * cannot be read from the main thread's. They ride back on the final reply and
 * are parked here for the HUD and the budget suite.
 */
let lastPerf: PerfSnapshot | null = null;

export function lastExportPerf(): PerfSnapshot | null {
  return lastPerf;
}

/**
 * The encoder configuration the last render actually used.
 *
 * `hardwareAcceleration` here is what the browser CHOSE, not what was asked
 * for: it is the difference between an export that takes a minute and one that
 * takes ten, and until it was reported nothing in the app - or in any bug
 * report about a slow export - could tell the two apart.
 */
let lastEncoder: ExportEncoderInfo | null = null;

export function lastExportEncoder(): ExportEncoderInfo | null {
  return lastEncoder;
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
