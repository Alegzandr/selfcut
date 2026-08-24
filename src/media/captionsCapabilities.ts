import { CAPTION_MODELS, type CaptionDevice, type CaptionModelInfo } from './captionsModel';

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
  /** navigator.deviceMemory in GB, when exposed (Chromium only). */
  memoryGb?: number;
}

let probe: Promise<CaptionCapabilities> | null = null;

/** Probe once per session: requesting an adapter is not free, and nothing here changes mid-session. */
export function captionCapabilities(): Promise<CaptionCapabilities> {
  probe ??= (async (): Promise<CaptionCapabilities> => {
    const memoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
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
            memoryGb,
          };
        }
      } catch {
        // No adapter, or the request threw: wasm it is.
      }
    }
    return { device: 'wasm', memoryGb };
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
  // WebGPU allocates the largest weight tensor as one buffer, so an adapter with
  // a small cap fails at load time rather than running slowly.
  const needBytes = model.sizeMb.webgpu * 1024 * 1024;
  if (caps.maxBufferBytes != null && needBytes > caps.maxBufferBytes * 4) return 'unsupported';
  if (model.quality === 4) return caps.memoryGb != null && caps.memoryGb < 8 ? 'slow' : 'recommended';
  return model.quality >= 3 ? 'recommended' : 'usable';
}

/** The model to preselect on a machine that has never chosen one. */
export function bestDefaultModel(caps: CaptionCapabilities): string {
  const ranked = [...CAPTION_MODELS].sort((a, b) => b.quality - a.quality);
  return (ranked.find((m) => captionFit(m, caps) === 'recommended') ?? ranked[ranked.length - 1]!).id;
}
