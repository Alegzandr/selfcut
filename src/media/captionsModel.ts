/**
 * The Whisper models auto-captions can run, and what each one costs.
 *
 * There is no single right pick: a laptop with WebGPU transcribes an hour with
 * `large-v3-turbo` faster than a wasm-only machine gets through ten minutes with
 * `base`, and the download ranges from a phone-sized 150 MB to most of a
 * gigabyte. So the choice is the user's, made in front of the numbers and of
 * what their machine actually supports (see `captionsCapabilities`).
 *
 * The weights load from the HuggingFace hub and are cached by the browser after
 * the first run (see the CSP note in vite.config.ts, and `captionsCache` for the
 * download/delete side). To make captions fully offline, self-host the model
 * files like the ffmpeg core and point transformers.js at that path - no code
 * here changes but the URL.
 */

/** Which backend the worker ended up on; the model's size and dtype follow it. */
export type CaptionDevice = 'webgpu' | 'wasm';

/** The weight precisions used here, a subset of what transformers.js accepts. */
export type CaptionDtype = 'fp32' | 'fp16' | 'q8' | 'q4';

/** One precision for the whole model, or one per ONNX file. */
export type CaptionDtypeSpec = CaptionDtype | Record<string, CaptionDtype>;

export interface CaptionModelInfo {
  /** Stable key, persisted in the preference - NOT the repo id, which can move. */
  id: string;
  /** HuggingFace repo, packaged for transformers.js v4. */
  repo: string;
  /** Shown as-is: model names are not translated, and 'base' is not a French word to find. */
  name: string;
  /**
   * Rough download size per backend, in MB. Approximate on purpose: what is
   * actually fetched depends on the dtype resolution transformers.js does per
   * file, and the exact figure is shown from the cache once a model is here.
   */
  sizeMb: Record<CaptionDevice, number>;
  /** 1..4, only ever compared against the other rows. Drives the quality bars. */
  quality: 1 | 2 | 3 | 4;
  /**
   * Set when the model is only sensible on a GPU: at fp32 on wasm this one is
   * a multi-gigabyte download that then transcribes slower than real time, which
   * is not a choice worth offering as if it were one.
   */
  gpuOnly?: boolean;
  /**
   * Weight precision per backend. wasm stays fp32 across the board: the
   * quantized loaders some Whisper builds ship hit onnxruntime-web bugs, and a
   * caption run that crashes is worse than one that downloads more.
   */
  dtype: Record<CaptionDevice, CaptionDtypeSpec>;
  /**
   * Precision to use on a WebGPU adapter that lacks `shader-f16`.
   *
   * WebGPU is one API but not one capability set: fp16 shaders are an optional
   * feature, and an adapter without them does not silently promote to fp32 -
   * the session fails to build, after the download. Only meaningful on a model
   * whose `dtype.webgpu` asks for fp16 in the first place.
   */
  dtypeNoF16?: CaptionDtypeSpec;
}

export const CAPTION_MODELS: CaptionModelInfo[] = [
  {
    id: 'tiny',
    repo: 'onnx-community/whisper-tiny',
    name: 'Whisper tiny',
    sizeMb: { webgpu: 155, wasm: 155 },
    quality: 1,
    dtype: { webgpu: 'fp32', wasm: 'fp32' },
  },
  {
    id: 'base',
    repo: 'onnx-community/whisper-base',
    name: 'Whisper base',
    sizeMb: { webgpu: 290, wasm: 290 },
    quality: 2,
    dtype: { webgpu: 'fp32', wasm: 'fp32' },
  },
  {
    id: 'small',
    repo: 'onnx-community/whisper-small',
    name: 'Whisper small',
    sizeMb: { webgpu: 970, wasm: 970 },
    quality: 3,
    dtype: { webgpu: 'fp32', wasm: 'fp32' },
  },
  {
    id: 'large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    name: 'Whisper large v3 turbo',
    // Mixed precision: the encoder is the heavy half and survives fp16, the
    // decoder is the one that runs per token and is the one worth quantizing.
    sizeMb: { webgpu: 800, wasm: 0 },
    quality: 4,
    gpuOnly: true,
    dtype: {
      webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      wasm: 'fp32',
    },
    // Adapters without shader-f16 exist (some AMD and Intel drivers on Windows,
    // older Mesa on Linux); q8 keeps the encoder on the GPU for a comparable
    // download instead of failing the load. Apple Silicon always reports the
    // feature, so this is not the Mac path.
    dtypeNoF16: { encoder_model: 'q8', decoder_model_merged: 'q4' },
  },
];

/** The model used when nothing has been chosen: the previous hard-coded one. */
export const DEFAULT_CAPTION_MODEL = 'base';

export function captionModel(id: string): CaptionModelInfo {
  return CAPTION_MODELS.find((m) => m.id === id) ?? CAPTION_MODELS.find((m) => m.id === DEFAULT_CAPTION_MODEL)!;
}

function usesF16(spec: CaptionDtypeSpec): boolean {
  return typeof spec === 'string' ? spec === 'fp16' : Object.values(spec).includes('fp16');
}

/**
 * The precision to load `model` at on a WebGPU adapter, given whether that
 * adapter exposes `shader-f16`.
 *
 * `null` means this machine cannot run the model on the GPU at all: the model
 * only exists as an fp16 proposition and the adapter has no fp16. Callers rule
 * it out up front rather than letting the pipeline throw once the weights are
 * already on disk.
 */
export function webgpuDtype(model: CaptionModelInfo, f16: boolean): CaptionDtypeSpec | null {
  const spec = model.dtype.webgpu;
  if (f16 || !usesF16(spec)) return spec;
  if (model.dtypeNoF16 && !usesF16(model.dtypeNoF16)) return model.dtypeNoF16;
  return null;
}
