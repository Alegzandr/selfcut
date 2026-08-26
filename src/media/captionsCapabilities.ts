import {
  CAPTION_MODELS,
  webgpuDtype,
  type CaptionDevice,
  type CaptionModelInfo,
} from './captionsModel';

/**
 * What this machine can actually run captions on, so the model picker states it
 * instead of letting the user discover it after a 900 MB download.
 *
 * The probe is the same one the worker makes before choosing a backend
 * (`navigator.gpu` can exist with no adapter behind it), kept in one place so
 * what the picker promises and what the run does cannot drift apart.
 */

export interface CaptionCapabilities {
  /** The backend a run would take right now. */
  device: CaptionDevice;
  /** Adapter description when WebGPU is available ('Apple M2', 'NVIDIA…'), if the browser tells us. */
  adapter?: string;
  /** Largest single buffer the adapter allows, in bytes - the cap the big models run into. */
  maxBufferBytes?: number;
  /**
   * Whether the adapter exposes `shader-f16`, WebGPU's optional half-precision
   * feature. Always false without WebGPU. It is the one capability difference
   * between GPUs that changes which weights are downloaded (see `webgpuDtype`).
   */
  f16: boolean;
  /** navigator.deviceMemory in GB, when exposed (Chromium only). */
  memoryGb?: number;
  /**
   * A touch-first device (`pointer: coarse`) - a phone or a tablet.
   *
   * Not a proxy for "weak": a recent phone runs the small models on its GPU
   * perfectly well. It changes what a download and a long GPU run COST, which
   * is what the ratings below are about. Always false off the main thread, where
   * there is no `matchMedia` to ask - the worker only reads `device` and `f16`.
   */
  handheld: boolean;
}

function coarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

let probe: Promise<CaptionCapabilities> | null = null;

/** Probe once per session: requesting an adapter is not free, and nothing here changes mid-session. */
export function captionCapabilities(): Promise<CaptionCapabilities> {
  probe ??= (async (): Promise<CaptionCapabilities> => {
    const memoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    const handheld = coarsePointer();
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
    if (gpu) {
      try {
        const adapter = await gpu.requestAdapter();
        if (adapter) {
          // `info` is the current spec surface; older Chromium exposed the same
          // strings through the now-removed requestAdapterInfo().
          const info = (adapter as unknown as { info?: GPUAdapterInfo }).info;
          const name = [info?.vendor, info?.architecture].filter(Boolean).join(' ').trim();
          return {
            device: 'webgpu',
            adapter: name || undefined,
            maxBufferBytes: adapter.limits?.maxBufferSize,
            f16: adapter.features?.has('shader-f16') ?? false,
            memoryGb,
            handheld,
          };
        }
      } catch {
        // No adapter, or the request threw: wasm it is.
      }
    }
    return { device: 'wasm', f16: false, memoryGb, handheld };
  })();
  return probe;
}

/** How a model rates on this machine, for the badge the picker shows on each row. */
export type CaptionFit = 'recommended' | 'usable' | 'slow' | 'unsupported';

/**
 * Rate `model` against `caps`.
 *
 * The thresholds are deliberately coarse. There is no API that reports "this
 * will take four minutes", and pretending otherwise would put a number on the
 * screen that the first counter-example makes a lie - so the rating says which
 * side of usable a model falls on, and the size column carries the rest.
 */
export function captionFit(model: CaptionModelInfo, caps: CaptionCapabilities): CaptionFit {
  if (caps.device === 'wasm') {
    // Without a GPU every layer runs on the CPU: the big models still produce
    // the right words, just not within a wait anyone sits through.
    if (model.gpuOnly) return 'unsupported';
    if (model.quality >= 3) return 'slow';
    return model.quality === 2 ? 'recommended' : 'usable';
  }
  const dtype = webgpuDtype(model, caps.f16);
  // Nothing to load: fp16-only weights on an adapter with no fp16.
  if (!dtype) return 'unsupported';
  // WebGPU allocates the largest weight tensor as one buffer, so an adapter with
  // a small cap fails at load time rather than running slowly.
  const needBytes = model.sizeMb.webgpu * 1024 * 1024;
  if (caps.maxBufferBytes != null && needBytes > caps.maxBufferBytes * 4) return 'unsupported';
  // The no-f16 fallback runs, at a precision this project has not measured
  // against the fp16 path: offer it, do not recommend it.
  if (dtype !== model.dtype.webgpu) return 'usable';
  if (caps.handheld) {
    // A phone GPU transcribes; what it does not have is the room for a
    // gigabyte of weights, nor the thermal headroom for a long run, nor
    // usually an unmetered connection to fetch them over.
    if (model.quality === 4) return 'slow';
    return model.quality === 3 ? 'usable' : 'recommended';
  }
  if (model.quality === 4) {
    // navigator.deviceMemory is Chromium-only: on Safari and Firefox there is
    // no RAM figure at all. Saying 'recommended' there would be a promise made
    // on no evidence, and 'slow' an accusation on the same - an M-series Mac in
    // Safari is exactly the machine this model is best on. 'usable' is the
    // honest answer: it runs, and nothing here knows whether it runs well.
    if (caps.memoryGb == null) return 'usable';
    return caps.memoryGb < 8 ? 'slow' : 'recommended';
  }
  return model.quality >= 3 ? 'recommended' : 'usable';
}

/**
 * Whether to offer auto-captions on this machine at all.
 *
 * The gate used to be the pointer type: touch meant no captions, full stop.
 * That was a stand-in for the real question, and it got both ends wrong - it
 * refused a phone with a GPU that transcribes a minute of audio in seconds, and
 * it would have accepted a laptop with no WebGPU at all. So ask the machine
 * instead: on a handheld the wasm path is not a slower option but an hour of the
 * device at full tilt with the screen hot, so there a GPU is the condition;
 * on a desktop the CPU fallback stays offered, as it always was.
 */
export function captionsSupported(caps: CaptionCapabilities): boolean {
  return caps.device === 'webgpu' || !caps.handheld;
}

/** The model to preselect on a machine that has never chosen one. */
export function bestDefaultModel(caps: CaptionCapabilities): string {
  const ranked = [...CAPTION_MODELS].sort((a, b) => b.quality - a.quality);
  return (ranked.find((m) => captionFit(m, caps) === 'recommended') ?? ranked[ranked.length - 1]!).id;
}
