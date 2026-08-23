import { AudioTrackInfo, isTrackPlayable } from '../types';

/**
 * What a full audio decode is going to cost, and what the machine can afford.
 *
 * The decode strategy is deliberate: every source audio track is decoded once
 * into a single `AudioBuffer` (see `mediaCache.ts`), which is instant to
 * schedule and identical for the preview and the export. It is also the
 * heaviest thing the editor holds - 48 kHz stereo float is ~23 MB per minute -
 * so it has to fail on purpose rather than by accident.
 *
 * Two failures are possible and they are not the same problem:
 *
 * 1. **One track too large.** A 90-minute stereo podcast is a 2 GB buffer, in
 *    ONE indivisible allocation. No eviction can help: there is nothing to free
 *    that makes a single object fit. This is the case that kills the tab, and
 *    the only one worth warning about before decoding.
 * 2. **A batch larger than the budget.** Nothing crashes - the LRU in
 *    `mediaCache` handles it - but the cache thrashes: decode, evict, decode
 *    again on the next scrub. Worth a word, not an alarm.
 *
 * Everything here is pure and testable without a browser; `readMemoryEnv` is
 * the one impure function, and it only reads.
 */

/** A decoded sample is one f32 per channel. */
const BYTES_PER_SAMPLE = 4;

/**
 * Assumed when the container does not state a rate. 48 kHz is what browsers
 * decode to in practice, and guessing low here would under-estimate the very
 * thing this module exists to bound.
 */
export const DEFAULT_SAMPLE_RATE = 48_000;

/**
 * Bytes one track occupies once decoded.
 *
 * Mirrors `decodeFullAudio`'s own allocation, second of slack included: the
 * point is to predict the exact object that is about to be created, not to
 * describe audio in general.
 */
export function decodedTrackBytes(
  durationMs: number,
  track: { sampleRate?: number; channels?: number },
): number {
  const sampleRate = track.sampleRate && track.sampleRate > 0 ? track.sampleRate : DEFAULT_SAMPLE_RATE;
  const channels = Math.max(1, track.channels ?? 2);
  const frames = Math.ceil((Math.max(0, durationMs) / 1000) * sampleRate) + sampleRate;
  return frames * channels * BYTES_PER_SAMPLE;
}

/** One track of an asset, sized. */
export interface TrackEstimate {
  /** `AudioTrackInfo.index`, i.e. what a clip stores in `audioTrackIndex`. */
  index: number;
  bytes: number;
}

/**
 * Size every track that would actually be decoded. Undecodable tracks are
 * skipped: they decode to nothing until an explicit transcode, which is a
 * different path with its own progress and its own cache.
 */
export function estimateAudioTracks(
  durationMs: number,
  tracks: readonly AudioTrackInfo[],
): TrackEstimate[] {
  return tracks
    .filter(isTrackPlayable)
    .map((track) => ({ index: track.index, bytes: decodedTrackBytes(durationMs, track) }));
}

/** What an import adds to the cache if every playable track is decoded. */
export function estimateAssetBytes(
  durationMs: number,
  tracks: readonly AudioTrackInfo[],
): number {
  return estimateAudioTracks(durationMs, tracks).reduce((sum, track) => sum + track.bytes, 0);
}

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
 * under-reports from disabling the cache outright - one track still has to fit,
 * which is the case it exists for - and the ceiling stops a 64 GB workstation
 * from handing us a budget large enough to be the problem again.
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
 * The largest single track worth decoding up front.
 *
 * Half the budget rather than a second machine heuristic: one number to reason
 * about, and it already tracks the device. On a machine reporting 4 GB that is
 * ~429 MB, about 18 minutes of 48 kHz stereo - which the short-form editing
 * this targets never reaches, and which a two-hour rip exceeds immediately. A
 * guard should be invisible in the use case and present outside it.
 *
 * Note what being over the cap does and does not mean: the track is not
 * refused, it is not decoded on speculation. Putting the clip on the timeline
 * still decodes it, because that is the user asking.
 */
export function trackDecodeCapBytes(budgetBytes: number): number {
  return Math.round(budgetBytes * 0.5);
}

/**
 * How far past the budget a single import goes before it is worth mentioning.
 *
 * Not an error and barely a warning: the cache evicts, so the cost is a
 * re-decode, not a failure. Twice the budget keeps the notice off a normal
 * folder drop.
 */
export const BATCH_NOTICE_FACTOR = 2;

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
 * an allocation failure is swallowed by the cache's `catch`, the track is
 * silently null, and the user gets a mute clip with no explanation - or, when
 * it happens during an export, a video whose sound is simply missing.
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
