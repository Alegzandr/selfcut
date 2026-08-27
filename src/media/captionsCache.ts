import { CAPTION_MODELS, type CaptionModelInfo } from './captionsModel';

/**
 * The on-disk side of the caption models: what has already been downloaded, how
 * much room it takes, and how to get it back.
 *
 * transformers.js stores every weight file it fetches in a Cache Storage bucket
 * named `transformers-cache`, keyed by the full HuggingFace URL
 * (`https://huggingface.co/<repo>/resolve/main/<file>`). That is a public,
 * inspectable store, so the model manager reads it directly rather than keeping a
 * parallel ledger that could disagree with what is actually on the machine.
 *
 * The same bucket also holds the onnxruntime wasm binaries, which are shared by
 * every model and are not anybody's model: deleting by repo prefix leaves them
 * alone by construction.
 */

/**
 * The bucket transformers.js writes into (`env.cacheKey`). Shared with the
 * downloader, which fills the same bucket by hand: two names for one store is
 * how a model ends up downloaded and then downloaded again.
 */
export const CAPTION_CACHE_NAME = 'transformers-cache';
const CACHE_NAME = CAPTION_CACHE_NAME;

export interface CachedModel {
  /** Bytes the model's files occupy, as measured, not as advertised. */
  bytes: number;
  /** How many files - a partial download (an interrupted run) shows up as a small count. */
  files: number;
}

/** Whether the browser exposes Cache Storage at all (it is absent in some private modes). */
export function captionCacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

async function openCache(): Promise<Cache | null> {
  if (!captionCacheAvailable()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** True when `url` is a weight file of `model` - the repo id is the whole test. */
function belongsTo(url: string, model: CaptionModelInfo): boolean {
  return url.includes(`/${model.repo}/`);
}

/**
 * Measure one response without reading its body when we can help it.
 *
 * Content-Length is present on hub responses and costs nothing; falling back to
 * the blob is a full read of a file that can be hundreds of megabytes, so it is
 * only there for the responses that arrive without the header.
 */
async function responseBytes(res: Response): Promise<number> {
  const stated = Number(res.headers.get('content-length'));
  if (Number.isFinite(stated) && stated > 0) return stated;
  try {
    return (await res.blob()).size;
  } catch {
    return 0;
  }
}

/**
 * What is cached, per model id. Models with nothing on disk are absent from the
 * map rather than present with a zero.
 */
export async function listCachedModels(): Promise<Map<string, CachedModel>> {
  const out = new Map<string, CachedModel>();
  const cache = await openCache();
  if (!cache) return out;
  const requests = await cache.keys();
  for (const model of CAPTION_MODELS) {
    const mine = requests.filter((r) => belongsTo(r.url, model));
    if (mine.length === 0) continue;
    let bytes = 0;
    for (const request of mine) {
      const res = await cache.match(request);
      if (res) bytes += await responseBytes(res);
    }
    out.set(model.id, { bytes, files: mine.length });
  }
  return out;
}

/** Drop every cached file of one model. The next run re-downloads it. */
export async function deleteCachedModel(model: CaptionModelInfo): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  const requests = await cache.keys();
  await Promise.all(
    requests.filter((r) => belongsTo(r.url, model)).map((r) => cache.delete(r)),
  );
}

/**
 * Drop the whole bucket: every model, plus the shared onnxruntime binaries.
 *
 * Deliberately coarser than `deleteCachedModel`. This is the "erase everything"
 * path, where leaving a few hundred megabytes of runtime behind because no model
 * claims them would make the reported result a lie. All of it is re-fetched on
 * the next transcription.
 */
export async function deleteCaptionCache(): Promise<void> {
  if (!captionCacheAvailable()) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* storage denied - nothing was cached in the first place */
  }
}
