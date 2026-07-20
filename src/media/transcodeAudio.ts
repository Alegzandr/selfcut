import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { MediaAsset } from '../types';

/**
 * On-demand audio transcoding for tracks WebCodecs cannot decode (E-AC-3, AC-3,
 * DTS - the usual MKV/Blu-ray rip payload). Nothing here runs unless the user
 * explicitly asks for a track: ffmpeg.wasm is a 32 MB download, so it is
 * dynamically imported on first use and never touches a normal import.
 *
 * The output is plain PCM in a WAV container, which the browser decodes
 * natively. Going through a lossy codec would save memory but degrade sound the
 * user is trying to recover, and the decoded AudioBuffer costs the same either
 * way (see the full-buffer limitation in mediaCache).
 */

/** Where the core is served from, copied out of node_modules at build time. */
const CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`;

/** Mount point of the source file inside ffmpeg's virtual filesystem. */
const MOUNT_DIR = '/mount';

/** The loaded instance plus the enum it needs, both from the same lazy chunk. */
interface LoadedFFmpeg {
  ffmpeg: FFmpeg;
  workerFs: string;
}

let ffmpegPromise: Promise<LoadedFFmpeg> | null = null;

/**
 * Load ffmpeg.wasm once per session. Single-threaded on purpose: the
 * multi-threaded core needs COOP/COEP headers, which GitHub Pages cannot send
 * (the CSP already ships as a meta tag for the same reason).
 */
function loadFFmpeg(): Promise<LoadedFFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg, FFFSType } = await import('@ffmpeg/ffmpeg');
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: `${CORE_BASE}/ffmpeg-core.js`,
        wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
      });
      return { ffmpeg, workerFs: FFFSType.WORKERFS };
    })().catch((err) => {
      // A failed load must not poison the session: let the next attempt retry.
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

/**
 * Drop the cached instance. Terminating kills the worker, so the handle is dead
 * and the next transcode has to load a fresh one (the wasm itself stays in the
 * HTTP cache, so this costs no second download).
 */
function discardFFmpeg(): void {
  ffmpegPromise = null;
}

export class TranscodeCanceled extends Error {
  constructor() {
    super('canceled');
    this.name = 'TranscodeCanceled';
  }
}

export interface TranscodeOptions {
  /** 0..1 over the whole job. Reported from ffmpeg's own progress events. */
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * Decode one undecodable audio track into an AudioBuffer.
 *
 * `audioTrackIndex` is the track's position among the file's audio tracks,
 * which is exactly what ffmpeg's `0:a:<n>` stream specifier selects, so the
 * index needs no translation.
 *
 * Throws TranscodeCanceled if `signal` aborts, and a plain Error (already
 * translated by the caller) on any ffmpeg failure.
 */
export async function transcodeAudioTrack(
  asset: MediaAsset,
  audioTrackIndex: number,
  { onProgress, signal }: TranscodeOptions = {},
): Promise<AudioBuffer> {
  if (signal?.aborted) throw new TranscodeCanceled();
  onProgress?.(0);
  const { ffmpeg, workerFs } = await loadFFmpeg();
  if (signal?.aborted) throw new TranscodeCanceled();

  const outName = `out-${audioTrackIndex}.wav`;
  const report = (ratio: number) => onProgress?.(Math.min(1, Math.max(0, ratio)));
  const onFFmpegProgress = ({ progress }: { progress: number }) => report(progress);
  ffmpeg.on('progress', onFFmpegProgress);

  // Terminating is the only way to interrupt a running exec; it destroys the
  // worker, so the cached handle has to go with it.
  const abort = () => {
    discardFFmpeg();
    ffmpeg.terminate();
  };
  signal?.addEventListener('abort', abort, { once: true });

  let mounted = false;
  try {
    // WORKERFS reads the File lazily through the worker instead of copying it
    // into ffmpeg's heap: a multi-GB MKV would never fit in memory otherwise.
    await ffmpeg.createDir(MOUNT_DIR).catch(() => undefined);
    await ffmpeg.mount(workerFs as never, { files: [asset.file] }, MOUNT_DIR);
    mounted = true;

    const code = await ffmpeg.exec([
      '-i',
      `${MOUNT_DIR}/${asset.file.name}`,
      // Picture and subtitles are already handled natively: only lift the sound.
      '-map',
      `0:a:${audioTrackIndex}`,
      '-vn',
      '-sn',
      '-dn',
      // Downmix to stereo: the mix bus is stereo, and a 5.1 source would
      // otherwise waste three channels' worth of memory to be folded anyway.
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      outName,
    ]);
    if (signal?.aborted) throw new TranscodeCanceled();
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);

    const data = await ffmpeg.readFile(outName);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    // Copy into a standalone ArrayBuffer: decodeAudioData detaches what it is
    // given, and ffmpeg's view points into the wasm heap.
    const wav = bytes.slice().buffer as ArrayBuffer;
    await ffmpeg.deleteFile(outName).catch(() => undefined);

    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buffer = await ctx.decodeAudioData(wav);
    report(1);
    return buffer;
  } finally {
    ffmpeg.off('progress', onFFmpegProgress);
    signal?.removeEventListener('abort', abort);
    if (mounted) await ffmpeg.unmount(MOUNT_DIR).catch(() => undefined);
  }
}
