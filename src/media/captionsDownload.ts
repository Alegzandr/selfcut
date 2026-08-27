import { CAPTION_CACHE_NAME } from './captionsCache';
import type { CaptionDevice, CaptionDtypeSpec, CaptionModelInfo } from './captionsModel';

/**
 * Fetch a Whisper model's files into the browser cache, and nothing else.
 *
 * The model manager used to "download" a model by building the pipeline and
 * throwing it away, on the grounds that whatever the pipeline fetches is
 * exactly what a run needs. True, and far too expensive: building the pipeline
 * reads every weight file whole into memory and then hands it to onnxruntime,
 * which allocates the session on top. On a desktop that peak is affordable; on
 * an iPhone it is over Safari's per-tab ceiling, and the tab dies at the very
 * end of the download - the point where nothing has been committed to the cache
 * yet, so the next attempt starts the same download over.
 *
 * So the download is a download: ask transformers.js which files this model at
 * this precision will ask for (`ModelRegistry`, its own resolution logic, not a
 * guess of ours), then stream each one straight into the cache it reads from.
 * Memory stays flat at one chunk, whatever the file weighs, and the run that
 * follows finds everything already there.
 *
 * The cache keys are the full hub URLs because that is what transformers.js
 * looks up (`buildResourcePaths`, browser cache branch) - the same shape
 * `captionsCache` measures and deletes by.
 */

const HUB = 'https://huggingface.co';

function fileUrl(repo: string, file: string): string {
  return `${HUB}/${repo}/resolve/main/${file}`;
}

/** A file the model cannot load without - a missing one is a failed download, not a skip. */
function required(file: string): boolean {
  return file.endsWith('.onnx') || file.includes('.onnx_data');
}

/** The cache write was refused (quota, private mode): worth its own message. */
export class CaptionStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionStorageError';
  }
}

/** One file's size, and whether it is on the hub at all. */
async function plan(
  repo: string,
  files: string[],
  cache: Cache,
  signal?: AbortSignal,
): Promise<Array<{ url: string; bytes: number }>> {
  const { ModelRegistry } = await import('@huggingface/transformers');
  const out: Array<{ url: string; bytes: number }> = [];
  for (const file of files) {
    if (signal?.aborted) return out;
    const url = fileUrl(repo, file);
    if (await cache.match(url)) continue;
    const meta = await ModelRegistry.get_file_metadata(repo, file);
    if (!meta.exists) {
      // Some entries are conditional (a generation config a repo may not ship).
      // A weight file is not: reporting success without it would leave the
      // manager showing a downloaded model that cannot load.
      if (required(file)) throw new Error(`${file} is missing from ${repo}`);
      continue;
    }
    out.push({ url, bytes: meta.size ?? 0 });
  }
  return out;
}

/**
 * Copy one response body into the cache as it arrives, counting bytes.
 *
 * `cache.put` consumes the stream, so the counter sits in a transform between
 * the two rather than in a read loop that would have to buffer the whole file
 * to hand it on. Content-Length is carried over explicitly: the Cache API
 * strips it from a streamed response, and `captionsCache` measures with it.
 */
async function store(
  cache: Cache,
  url: string,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);

  let body: BodyInit | null = res.body;
  if (res.body) {
    body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          onBytes(chunk.byteLength);
          controller.enqueue(chunk);
        },
      }),
    );
  }
  const headers = new Headers(res.headers);
  const stated = res.headers.get('content-length');
  if (stated) headers.set('content-length', stated);

  try {
    await cache.put(url, new Response(body, { status: 200, headers }));
  } catch (err) {
    throw new CaptionStorageError(`browser cache refused ${url}: ${String(err)}`);
  }
  // Storage can also fail silently under pressure - an eviction between the put
  // and now. Better to say so than to report a model that is not there.
  if (!(await cache.match(url)))
    throw new CaptionStorageError(`browser cache dropped ${url}`);
}

/**
 * Download `model` at `dtype`, reporting 0..1 over the total still to fetch.
 *
 * Resumable in the only sense that matters here: files already in the cache are
 * skipped, so a cancelled or crashed run picks up where it stopped instead of
 * starting the several hundred megabytes again.
 */
export async function downloadCaptionModel(
  model: CaptionModelInfo,
  device: CaptionDevice,
  dtype: CaptionDtypeSpec,
  onProgress: (value: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof caches === 'undefined')
    throw new CaptionStorageError('this browser exposes no cache storage');
  const { ModelRegistry, env } = await import('@huggingface/transformers');
  // Hub weights only, as in the worker: without this the registry looks for a
  // local model directory first and every lookup pays for a 404.
  env.allowLocalModels = false;

  const files = await ModelRegistry.get_pipeline_files(
    'automatic-speech-recognition',
    model.repo,
    { dtype, device },
  );
  const cache = await caches.open(CAPTION_CACHE_NAME);
  const todo = await plan(model.repo, files, cache, signal);
  if (signal?.aborted) return;

  const total = todo.reduce((sum, f) => sum + f.bytes, 0);
  let loaded = 0;
  // Everything already cached: say so once rather than leaving the bar at zero.
  if (todo.length === 0) {
    onProgress(1);
    return;
  }
  for (const file of todo) {
    if (signal?.aborted) return;
    await store(
      cache,
      file.url,
      (n) => {
        loaded += n;
        // A size read from a Range request can disagree with what arrives; the
        // bar must not overshoot on the last chunk of the last file.
        onProgress(total > 0 ? Math.min(1, loaded / total) : 0);
      },
      signal,
    );
  }
  onProgress(1);
}
