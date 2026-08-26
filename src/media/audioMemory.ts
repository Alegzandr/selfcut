/**
 * How much decoded audio this machine can afford to hold.
 *
 * Decoded PCM is the heaviest thing the editor keeps - 48 kHz stereo float is
 * ~23 MB per minute - so how much of it is live has to be a decision rather
 * than an accident. It used to be neither: every source track was decoded whole
 * into one `AudioBuffer`, which made an hour-long recording a 1.4 GB allocation
 * that no eviction could rescue, since there is nothing to free that makes a
 * single object fit.
 *
 * Audio is now decoded in segments (see `audioSegments.ts`), so no single
 * allocation is ever large and what is held is a function of what is being
 * played. That turns the question from "will this file fit?" - which had no
 * good answer, and produced a warning at import that the user could do nothing
 * about - into "how much of the timeline stays warm?", which is what the budget
 * below sets and what `mediaCache`'s LRU enforces.
 *
 * Everything here is pure and testable without a browser; `readMemoryEnv` is
 * the one impure function, and it only reads.
 */

/** What the machine will admit about itself. Every field is optional on purpose. */
export interface MemoryEnv {
  /** `navigator.deviceMemory`, in GB. Chrome/Edge only, coarse, capped at 8. */
  deviceMemoryGb?: number;
  /**
   * `performance.memory.jsHeapSizeLimit`, in bytes. Chrome only, non-standard.
   *
   * Used as a CEILING and nothing else. An `AudioBuffer`'s samples do not live
   * on the JS heap in Chrome - they are an external allocation - so
   * `usedJSHeapSize` would never see the hundreds of megabytes this module is
   * about, and reading it as a live gauge would give a measurement that is both
   * wrong and reassuring. The limit itself is still a real fact about the
   * process, and the one case it catches is a build with a small heap where
   * everything else is over-optimistic.
   */
  jsHeapSizeLimitBytes?: number;
  /**
   * `(pointer: coarse)` - the same signal that gates auto-captions.
   *
   * Only consulted when `deviceMemory` is missing, which in practice means
   * Safari, which in practice means an iPad. Assuming a desktop's RAM there is
   * the one place this heuristic would be blind AND wrong.
   */
  coarsePointer?: boolean;
}

const MIN_BUDGET_BYTES = 192 * 1024 * 1024;
const MAX_BUDGET_BYTES = 1024 * 1024 * 1024;
/** A fifth of reported RAM: the tab also holds decoded frames, canvases, the project. */
const RAM_SHARE = 0.2;
/** A quarter of the JS heap limit, applied as a ceiling only. */
const HEAP_SHARE = 0.25;
const ASSUMED_DESKTOP_GB = 4;
const ASSUMED_HANDHELD_GB = 2;

/**
 * How much decoded PCM may sit in memory at once.
 *
 * Derived from the machine for the same reason the on-disk cache derives its
 * own budget from the storage quota: the right number is a property of the
 * device, not something the app can guess. The floor keeps a browser that
 * under-reports from thrashing - it is several minutes of decoded audio either
 * way, far more than the window around the playhead needs - and the ceiling
 * stops a 64 GB workstation from handing us a budget large enough to be the
 * problem again.
 */
export function audioCacheBudgetBytes(env: MemoryEnv = {}): number {
  const gb = env.deviceMemoryGb ?? (env.coarsePointer ? ASSUMED_HANDHELD_GB : ASSUMED_DESKTOP_GB);
  const fromRam = gb * RAM_SHARE * 1024 * 1024 * 1024;
  const heapLimit = env.jsHeapSizeLimitBytes;
  const fromHeap =
    heapLimit != null && isFinite(heapLimit) && heapLimit > 0 ? heapLimit * HEAP_SHARE : Infinity;
  return Math.round(Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, Math.min(fromRam, fromHeap))));
}

/**
 * Whether a caught error is the browser refusing to allocate.
 *
 * There is no error type for this: Chrome throws `RangeError: Array buffer
 * allocation failed`, Safari `RangeError: Out of memory`, and a plain `Error`
 * is possible too. Matching the message is the only thing that works across
 * engines, so the set of phrases is the interface.
 */
export function isAllocationFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /allocation failed|out of memory|cannot allocate|invalid array (buffer )?length|array buffer allocation/i.test(
    message,
  );
}

/**
 * A decode that ran out of room, carrying what a message needs to name it.
 *
 * The point of the type is that the failure stops being anonymous: without it
 * an allocation failure is swallowed by the cache's `catch`, the segment is
 * silently null, and the user gets a clip that goes quiet for half a minute
 * with no explanation - or, when it happens during an export, a video whose
 * sound is simply missing.
 */
export class AudioMemoryError extends Error {
  constructor(
    readonly assetName: string,
    /** `AudioTrackInfo.index`, or undefined for the source's primary track. */
    readonly trackIndex: number | undefined,
    readonly estimatedBytes: number,
    options?: ErrorOptions,
  ) {
    super(`Out of memory decoding audio (${Math.round(estimatedBytes / 1e6)} MB): ${assetName}`, options);
    this.name = 'AudioMemoryError';
  }
}

/**
 * A size a person can read, in their own language ("1,1 Go" / "1.1 GB").
 *
 * `Intl` knows the unit names, so nothing here has to be translated by hand.
 */
export function formatBytes(bytes: number, locale?: string): string {
  const gb = bytes / 1e9;
  const [value, unit] = gb >= 1 ? [gb, 'gigabyte' as const] : [bytes / 1e6, 'megabyte' as const];
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: value >= 10 ? 0 : 1,
    }).format(value);
  } catch {
    // An engine without unit formatting still has to say something.
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit === 'gigabyte' ? 'GB' : 'MB'}`;
  }
}

/** Read what this browser exposes. Every signal is optional and every read is guarded. */
export function readMemoryEnv(): MemoryEnv {
  const env: MemoryEnv = {};
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number });
  if (typeof nav?.deviceMemory === 'number') env.deviceMemoryGb = nav.deviceMemory;
  const limit =
    typeof performance === 'undefined'
      ? undefined
      : (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory
          ?.jsHeapSizeLimit;
  if (typeof limit === 'number') env.jsHeapSizeLimitBytes = limit;
  // Only worth asking when the RAM signal is missing, which is the blind spot
  // this covers; elsewhere `deviceMemory` already says more than the pointer can.
  if (env.deviceMemoryGb == null && typeof window !== 'undefined' && window.matchMedia) {
    try {
      env.coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    } catch {
      /* a browser that will not answer is simply a browser we do not ask again */
    }
  }
  return env;
}
