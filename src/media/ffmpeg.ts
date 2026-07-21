import type { FFmpeg } from '@ffmpeg/ffmpeg';

/**
 * Shared ffmpeg.wasm runtime: load it once, run one job at a time, report
 * progress, allow cancellation.
 *
 * Everything the app cannot do with native browser codecs goes through here -
 * today an audio transcode and a subtitle extraction, tomorrow whatever else an
 * exotic import needs. Callers describe a job (a source file, the arguments, the
 * file it writes) and get bytes back; the download, the virtual filesystem and
 * the worker lifecycle are this module's business alone.
 *
 * Nothing in here runs unless a caller explicitly asks for a job: the core is a
 * 32 MB download, so it is dynamically imported on first use and never touches a
 * normal import path.
 */

/** Where the core is served from, copied out of node_modules at build time. */
const CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`;

/** Mount point of the source file inside ffmpeg's virtual filesystem. */
const MOUNT_DIR = '/mount';

/**
 * The stages a job goes through, in order. They are reported separately because
 * they fail differently and, above all, take wildly different amounts of time:
 * without the distinction a user watching 0 % for a minute of downloading cannot
 * tell a slow job from a hung one.
 *
 * 'queued' is the wait for the single-job queue below; the runtime only reports
 * the later phases, so it is set by whoever registers the job and is replaced as
 * soon as the job actually starts. Without it a job waiting behind three others
 * looks exactly like one that is downloading.
 *
 * 'decoding' is the caller's own post-processing (decoding PCM, parsing cues),
 * which the runtime cannot measure - it is reported by whoever does that work.
 */
export type FFmpegPhase = 'queued' | 'downloading' | 'converting' | 'decoding';

export interface FFmpegProgress {
  phase: FFmpegPhase;
  /** 0..1 inside the phase, or null when the phase reports no measurable progress. */
  ratio: number | null;
}

/** The loaded instance plus the enum it needs, both from the same lazy chunk. */
interface LoadedFFmpeg {
  ffmpeg: FFmpeg;
  workerFs: string;
}

let ffmpegPromise: Promise<LoadedFFmpeg> | null = null;

/**
 * Subscribers to the one-time core download. Kept module side so a second job
 * started while the first is still fetching sees the same bytes land, instead of
 * sitting at 0 % waiting on a download it cannot observe.
 */
const downloadListeners = new Set<(ratio: number | null) => void>();

/**
 * Fetch one file into a blob: URL, reporting bytes as they arrive.
 *
 * @ffmpeg/util ships toBlobURL for exactly this, but its progress path is unsafe:
 * it treats Content-Length as a checksum and throws when it disagrees with the
 * bytes read, which every compressed response guarantees - the header counts
 * bytes on the wire while the reader yields decoded ones. Its fallback then
 * calls arrayBuffer() on the body it has just consumed, which throws in turn, so
 * a single compressing host between us and the core makes load() fail outright.
 * Owning the fetch is less code than working around that.
 *
 * `total` is passed through as a hint, never as a contract: 0 means unknown.
 */
export async function fetchToBlobURL(
  url: string,
  mimeType: string,
  onBytes: (received: number, total: number) => void,
): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const declared = Number(resp.headers.get('Content-Length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0;

  const reader = resp.body?.getReader();
  // No streaming body to read: the response is still perfectly usable.
  if (!reader) {
    const buf = await resp.arrayBuffer();
    onBytes(buf.byteLength, buf.byteLength);
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received, total);
  }
  // Blob takes the chunks as they are: concatenating first would cost a second
  // full copy of 32 MB for nothing.
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mimeType }));
}

/**
 * Load ffmpeg.wasm once per session. Single-threaded on purpose: the
 * multi-threaded core needs COOP/COEP headers, which GitHub Pages cannot send
 * (the CSP already ships as a meta tag for the same reason).
 */
function loadFFmpeg(): Promise<LoadedFFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg, FFFSType } = await import('@ffmpeg/ffmpeg');

      // Fetched by hand rather than handed to load() as plain URLs, purely to
      // get byte progress out of the 32 MB download. Both end up as blob: URLs,
      // which the CSP allows in script-src for exactly this.
      const jsURL = `${CORE_BASE}/ffmpeg-core.js`;
      const binURL = `${CORE_BASE}/ffmpeg-core.wasm`;
      // Seeded so the ratio only goes measurable once both downloads have
      // declared a size, instead of jumping while the second one is still
      // opening its response.
      const bytes = new Map<string, { received: number; total: number }>([
        [jsURL, { received: 0, total: 0 }],
        [binURL, { received: 0, total: 0 }],
      ]);
      const track = (url: string) => (received: number, total: number) => {
        // Content-Length counts bytes on the wire, so on a compressed response
        // the reader outruns it. Once that happens the header says nothing
        // useful: drop it rather than pin the bar at 100 % for the rest.
        bytes.set(url, { received, total: received > total ? 0 : total });
        let got = 0;
        let expected = 0;
        let measurable = true;
        for (const b of bytes.values()) {
          got += b.received;
          if (b.total > 0) expected += b.total;
          else measurable = false;
        }
        // An unmeasurable download reports null: no bar beats a lying one.
        const ratio = measurable && expected > 0 ? Math.min(1, got / expected) : null;
        for (const listener of downloadListeners) listener(ratio);
      };
      const [coreURL, wasmURL] = await Promise.all([
        fetchToBlobURL(jsURL, 'text/javascript', track(jsURL)),
        fetchToBlobURL(binURL, 'application/wasm', track(binURL)),
      ]);

      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ coreURL, wasmURL });
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
 * and the next job has to load a fresh one (the wasm itself stays in the HTTP
 * cache, so this costs no second download).
 */
function discardFFmpeg(): void {
  ffmpegPromise = null;
}

export class FFmpegCanceled extends Error {
  constructor() {
    super('canceled');
    this.name = 'FFmpegCanceled';
  }
}

/**
 * Jobs run strictly one at a time. There is a single worker with a single
 * virtual filesystem, so two concurrent jobs would fight over the mount point
 * and interleave their progress events - and the user can perfectly well ask for
 * a subtitle track while an audio transcode is still running.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  // Runs on both settle paths: a job that failed must not block the next one.
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export interface FFmpegJob {
  /** Source file, mounted lazily rather than copied into the wasm heap. */
  file: File;
  /**
   * Arguments AFTER `-i <input>`. The last one is normally the output name,
   * which must match `output`.
   */
  args: string[];
  /** Name of the file the job writes, as it appears in `args`. */
  output: string;
  onProgress?: (progress: FFmpegProgress) => void;
  signal?: AbortSignal;
}

/**
 * Run one ffmpeg job over a local file and return the bytes it produced.
 *
 * The output is read and deleted from the virtual filesystem before returning,
 * so a long source never holds the wasm-side copy and the caller's copy at the
 * same time.
 *
 * Throws FFmpegCanceled if `signal` aborts, and a plain Error on any ffmpeg
 * failure (the caller owns the user-facing message).
 */
export function runFFmpegJob({
  file,
  args,
  output,
  onProgress,
  signal,
}: FFmpegJob): Promise<Uint8Array> {
  return enqueue(async () => {
    const report = (phase: FFmpegPhase, ratio: number | null): void => {
      onProgress?.({
        phase,
        ratio: ratio == null || !isFinite(ratio) ? null : Math.min(1, Math.max(0, ratio)),
      });
    };

    if (signal?.aborted) throw new FFmpegCanceled();
    report('downloading', 0);
    const onDownload = (ratio: number | null) => report('downloading', ratio);
    downloadListeners.add(onDownload);
    let loaded: LoadedFFmpeg;
    try {
      loaded = await loadFFmpeg();
    } finally {
      downloadListeners.delete(onDownload);
    }
    const { ffmpeg, workerFs } = loaded;
    if (signal?.aborted) throw new FFmpegCanceled();

    report('converting', 0);
    const onFFmpegProgress = ({ progress }: { progress: number }) => report('converting', progress);
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
      await ffmpeg.mount(workerFs as never, { files: [file] }, MOUNT_DIR);
      mounted = true;

      const code = await ffmpeg.exec(['-i', `${MOUNT_DIR}/${file.name}`, ...args]);
      if (signal?.aborted) throw new FFmpegCanceled();
      if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);

      const data = await ffmpeg.readFile(output);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      // Free the wasm-side copy before the caller starts building anything of
      // its own from these bytes.
      await ffmpeg.deleteFile(output).catch(() => undefined);
      return bytes;
    } finally {
      ffmpeg.off('progress', onFFmpegProgress);
      signal?.removeEventListener('abort', abort);
      if (mounted) await ffmpeg.unmount(MOUNT_DIR).catch(() => undefined);
    }
  });
}

/**
 * Detach a view produced by a job into an ArrayBuffer its consumer can own.
 *
 * decodeAudioData (and anything else taking ownership) detaches the buffer it is
 * handed, so it must own it whole. Crossing the worker boundary already produced
 * a standalone copy, and on an episode-length track that copy is hundreds of
 * megabytes: only re-copy when the view really is a window onto something larger.
 */
export function toOwnedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}
