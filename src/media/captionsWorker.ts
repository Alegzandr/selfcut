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

type Asr = ((
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{
  chunks?: Array<{ timestamp: [number, number | null]; text: string }>;
}>) & {
  /** The pipeline's own tokenizer, needed to read timestamp tokens as they stream. */
  tokenizer: unknown;
  processor?: { feature_extractor?: { config?: { chunk_length?: number } } };
  model?: { config?: { max_source_positions?: number } };
};

/**
 * The window the pipeline transcribes at a time, and its overlap. Passed to the
 * call below AND used to place each window on the timeline for progress, so the
 * two must agree - the pipeline chunks at exactly these numbers.
 */
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;

/** Whisper's own sample rate, the only one this worker is fed. */
const SAMPLE_RATE = 16000;

/**
 * Report how far into the audio the decoder has got.
 *
 * Whisper gives no progress of its own: it is handed a window and answers with
 * a transcript. What it does emit, token by token, is the timestamp of the
 * speech it is currently writing - so the position in the audio IS the progress,
 * and a streamer reading those tokens turns a spinner into a percentage.
 *
 * The timestamps are relative to the window, so each finished window advances
 * the offset by the pipeline's own jump (window minus both strides). Monotonic
 * on purpose: a window re-reads its overlap with the previous one, and a bar
 * that walks backwards every 20 seconds reads as a bug.
 */
function transcribeStreamer(
  Streamer: typeof import('@huggingface/transformers').WhisperTextStreamer,
  asr: Asr,
  durationSec: number,
): unknown {
  const jump = CHUNK_LENGTH_S - 2 * STRIDE_LENGTH_S;
  let windowIndex = 0;
  let furthestSec = 0;
  const at = (time: number) => {
    const sec = windowIndex * jump + time;
    if (sec <= furthestSec) return;
    furthestSec = sec;
    post({
      type: 'progress',
      stage: 'transcribe',
      value: Math.min(1, sec / durationSec),
    });
  };
  const chunkLength =
    asr.processor?.feature_extractor?.config?.chunk_length ?? 30;
  const maxPositions = asr.model?.config?.max_source_positions ?? 1500;
  return new Streamer(
    asr.tokenizer as ConstructorParameters<typeof Streamer>[0],
    {
      time_precision: chunkLength / maxPositions,
      on_chunk_start: at,
      on_chunk_end: at,
      on_finalize: () => {
        windowIndex++;
      },
    },
  );
}

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
    const durationSec = req.audio.length / SAMPLE_RATE;
    let streamer: unknown;
    try {
      if (durationSec > 0) {
        const { WhisperTextStreamer } = await import('@huggingface/transformers');
        streamer = transcribeStreamer(WhisperTextStreamer, asr, durationSec);
      }
    } catch (err) {
      // A model whose tokenizer the streamer cannot read still transcribes; it
      // just does it without a percentage. Losing the transcript over the
      // progress bar would be the wrong trade.
      console.warn('[captions] no progress stream:', err);
    }
    post({
      type: 'progress',
      stage: 'transcribe',
      value: streamer ? 0 : null,
    });
    const out = await asr(req.audio, {
      return_timestamps: true,
      chunk_length_s: CHUNK_LENGTH_S,
      stride_length_s: STRIDE_LENGTH_S,
      ...(streamer ? { streamer } : {}),
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
