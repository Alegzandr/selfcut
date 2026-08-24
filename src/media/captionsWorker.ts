/// <reference lib="webworker" />
import type { CaptionRequest, CaptionReply, CaptionSegment } from './captionsProtocol';
import { captionModel } from './captionsModel';

/**
 * Whisper transcription worker (desktop only). transformers.js is dynamically
 * imported the first time a job arrives, and each ASR pipeline is memoized for
 * the session, keyed by model - switching models in the picker must load the new
 * weights, not hand back the ones already in memory.
 *
 * WebGPU is used when a real adapter is available (fast); otherwise the model
 * runs on wasm, where every model stays at fp32: the quantized-weight loaders
 * hit onnxruntime-web bugs in some Whisper builds, and a crashed run is worse
 * than a larger download.
 */

type Asr = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>;

const pipelines = new Map<string, Promise<Asr>>();

function post(reply: CaptionReply): void {
  (self as unknown as Worker).postMessage(reply);
}

/** Whether a real WebGPU adapter is available (not just the `navigator.gpu` API). */
async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

async function getAsr(modelId: string): Promise<Asr> {
  const cached = pipelines.get(modelId);
  if (cached) return cached;
  const model = captionModel(modelId);
  const promise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Remote (HuggingFace hub) weights, cached by the browser after first use.
    env.allowLocalModels = false;
    const progress_callback = (p: { status?: string; progress?: number }) => {
      if (p.status === 'progress' && typeof p.progress === 'number') {
        post({ type: 'progress', stage: 'model', value: p.progress / 100 });
      }
    };
    // The WebGPU object can exist with no adapter behind it (headless, some
    // machines), and ONNX then fails at inference - so probe for a real adapter.
    if (await hasWebGpu()) {
      try {
        return (await pipeline('automatic-speech-recognition', model.repo, {
          device: 'webgpu',
          dtype: model.dtype.webgpu,
          progress_callback,
        })) as unknown as Asr;
      } catch (err) {
        // WebGPU present but unusable (driver, memory): fall through to wasm -
        // unless this model only exists as a GPU proposition, where the wasm
        // path would be a multi-gigabyte download to run slower than real time.
        if (model.gpuOnly) throw err;
      }
    }
    if (model.gpuOnly) throw new Error(`${model.name} requires WebGPU`);
    return (await pipeline('automatic-speech-recognition', model.repo, {
      device: 'wasm',
      dtype: model.dtype.wasm,
      progress_callback,
    })) as unknown as Asr;
  })();
  pipelines.set(modelId, promise);
  // A failed load must not be remembered as the model's answer forever: the
  // next attempt (after a delete/re-download, say) gets to try again.
  promise.catch(() => pipelines.delete(modelId));
  return promise;
}

self.onmessage = async (e: MessageEvent<CaptionRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'prefetch') {
      await getAsr(req.model);
      post({ type: 'ready' });
      return;
    }
    if (req.type !== 'transcribe') return;
    const asr = await getAsr(req.model);
    post({ type: 'progress', stage: 'transcribe', value: 1 });
    const out = await asr(req.audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      // Transcribe in the spoken language, never translate: with a language
      // pinned, the translation task would silently rewrite the captions into
      // another tongue.
      task: 'transcribe',
      // Whisper's degenerate mode: on hard audio the decoder falls into a loop
      // and emits the same token until the chunk ends. Benchmarked, the base
      // model went from 912% word error - a wall of one repeated syllable - to
      // 94% with 3-grams blocked, while turbo and small were unchanged. It
      // costs nothing when the decoding is healthy and saves the run when it
      // is not.
      no_repeat_ngram_size: 3,
      ...(req.language ? { language: req.language } : {}),
    });
    const segments: CaptionSegment[] = (out.chunks ?? [])
      .map((c) => ({ startSec: c.timestamp[0] ?? 0, endSec: c.timestamp[1], text: (c.text ?? '').trim() }))
      .filter((s) => s.text.length > 0);
    post({ type: 'result', segments });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
