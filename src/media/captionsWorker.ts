/// <reference lib="webworker" />
import type { CaptionRequest, CaptionReply, CaptionSegment } from './captionsProtocol';
import { CAPTION_MODEL } from './captionsModel';

/**
 * Whisper transcription worker (desktop only). transformers.js is dynamically
 * imported the first time a job arrives, and the ASR pipeline is memoized for the
 * session. WebGPU is used when a real adapter is available (fast); otherwise the
 * model runs on wasm at fp32 — slower and a bigger download, but avoids the
 * quantized-weight loader bugs some Whisper builds hit on onnxruntime-web.
 */

type Asr = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>;

let asrPromise: Promise<Asr> | null = null;

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

async function getAsr(): Promise<Asr> {
  if (asrPromise) return asrPromise;
  asrPromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Remote (HuggingFace hub) weights, cached by the browser after first use.
    env.allowLocalModels = false;
    const progress_callback = (p: { status?: string; progress?: number }) => {
      if (p.status === 'progress' && typeof p.progress === 'number') {
        post({ type: 'progress', stage: 'model', value: p.progress / 100 });
      }
    };
    // The WebGPU object can exist with no adapter behind it (headless, some
    // machines), and ONNX then fails at inference — so probe for a real adapter.
    if (await hasWebGpu()) {
      try {
        return (await pipeline('automatic-speech-recognition', CAPTION_MODEL, {
          device: 'webgpu',
          dtype: 'fp32',
          progress_callback,
        })) as unknown as Asr;
      } catch {
        // WebGPU present but unusable (driver, memory): fall through to wasm.
      }
    }
    return (await pipeline('automatic-speech-recognition', CAPTION_MODEL, {
      device: 'wasm',
      dtype: 'fp32',
      progress_callback,
    })) as unknown as Asr;
  })();
  return asrPromise;
}

self.onmessage = async (e: MessageEvent<CaptionRequest>) => {
  const req = e.data;
  if (req.type !== 'transcribe') return;
  try {
    const asr = await getAsr();
    post({ type: 'progress', stage: 'transcribe', value: 1 });
    const out = await asr(req.audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
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
