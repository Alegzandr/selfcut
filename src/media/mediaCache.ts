import type { Input, InputAudioTrack } from 'mediabunny';
import { mediabunny } from './mediabunnyModule';
import { MediaAsset, isTrackPlayable } from '../types';
import { StillFrame, decodeImageFile } from './stillImage';
import {
  AudioMemoryError,
  audioCacheBudgetBytes,
  formatBytes,
  isAllocationFailure,
  readMemoryEnv,
} from './audioMemory';
import {
  AudioSegment,
  SEGMENT_MS,
  segmentIndexes,
  segmentStartMs,
} from './audioSegments';

/**
 * Cache key for a single audio track of an asset. `undefined` means the source's
 * primary track (the historical single-track path); an explicit index addresses
 * one specific track of a multi-track source. Kept distinct so the primary and
 * "track 0" never collide.
 */
export function audioKey(assetId: string, audioTrackIndex?: number): string {
  return `${assetId}#${audioTrackIndex ?? 'p'}`;
}

/**
 * Decoding resource cache for the preview side (main thread).
 * Export uses its own Inputs inside the worker - the two pipelines share nothing.
 */

const inputs = new Map<string, Input>();

export async function createInput(file: File): Promise<Input> {
  const { Input: InputCtor, ALL_FORMATS, BlobSource } = await mediabunny();
  return new InputCtor({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

export function registerInput(assetId: string, input: Input): void {
  inputs.get(assetId)?.dispose();
  inputs.set(assetId, input);
}

/**
 * Drop (and close) the cached still frame of an asset. Called on removal and
 * when an image asset reconnects to a fresh file under the same id.
 */
export function resetStillFrame(assetId: string): void {
  void stillPromises.get(assetId)?.then((still) => still?.close());
  stillPromises.delete(assetId);
}

/** Release everything cached for an asset (decoder input, still frame, audio buffers, peaks). */
export function disposeAssetResources(assetId: string): void {
  inputs.get(assetId)?.dispose();
  inputs.delete(assetId);
  resetStillFrame(assetId);
  // Buffers/peaks are keyed per audio track (`${assetId}#…`): drop every entry
  // belonging to this asset, whatever its track index.
  const prefix = `${assetId}#`;
  for (const key of [...audioEntries.keys()]) if (key.startsWith(prefix)) audioEntries.delete(key);
  for (const key of [...peaksPromises.keys()]) if (key.startsWith(prefix)) peaksPromises.delete(key);
}

export async function getInput(asset: MediaAsset): Promise<Input> {
  const existing = inputs.get(asset.id);
  if (existing) return existing;
  const input = await createInput(asset.file);
  // Two concurrent callers can both miss the map while awaiting the module;
  // the first one to land wins, and the loser's Input is disposed rather than
  // leaked - two Inputs on one file would hold two demuxers.
  const raced = inputs.get(asset.id);
  if (raced) {
    input.dispose();
    return raced;
  }
  inputs.set(asset.id, input);
  return input;
}

const stillPromises = new Map<string, Promise<StillFrame | null>>();

/**
 * Rasterized still of an image asset, decoded once and shared by every clip
 * (a still never changes, so one bitmap serves all cursors and repaints).
 */
export function getStillFrame(asset: MediaAsset): Promise<StillFrame | null> {
  if (asset.kind !== 'image') return Promise.resolve(null);
  let promise = stillPromises.get(asset.id);
  if (!promise) {
    promise = decodeImageFile(asset.file)
      .then((bitmap) => new StillFrame(bitmap))
      .catch(() => null);
    stillPromises.set(asset.id, promise);
  }
  return promise;
}

/**
 * Resolve which source audio track to decode: an explicit `audioTrackIndex`
 * addresses one track of a multi-track file (falling back to the primary if it
 * is out of range), while `undefined` keeps the historical primary-track path.
 */
async function resolveAudioTrack(
  input: Input,
  audioTrackIndex?: number,
): Promise<InputAudioTrack | null> {
  if (audioTrackIndex == null) return input.getPrimaryAudioTrack();
  const tracks = await input.getAudioTracks();
  return tracks[audioTrackIndex] ?? (await input.getPrimaryAudioTrack());
}

/**
 * One memoized decode of a single SEGMENT of an audio track, plus what the
 * budget below needs to rank it. `bytes` is 0 until the decode resolves - an
 * in-flight entry cannot be sized, and evicting it would not free anything
 * anyway.
 */
interface AudioEntry {
  promise: Promise<AudioSegment | null>;
  /** Set once the decode resolves, so the mix can read it synchronously. */
  value: AudioSegment | null;
  bytes: number;
  /** Monotonic use stamp; see `useStamp`. */
  lastUsedAt: number;
  /**
   * Set for PCM published by a transcode: the source track is undecodable, so
   * dropping it does not cost a decode but a minutes-long ffmpeg conversion.
   * Ranked last, exactly like the on-disk cache pins timeline footage.
   */
  pinned: boolean;
}

/** Keyed by `${assetId}#${track}@${segmentIndex}` - see `segmentCacheKey`. */
const audioEntries = new Map<string, AudioEntry>();

/** Cache key of one segment of one track of one asset. */
export function segmentCacheKey(
  assetId: string,
  audioTrackIndex: number | undefined,
  index: number,
): string {
  return `${audioKey(assetId, audioTrackIndex)}@${index}`;
}

/**
 * A counter rather than a clock: two decodes resolving inside the same
 * millisecond must still order, and tests must not depend on wall time.
 */
let useStamp = 0;

/** Bytes an AudioBuffer occupies: one f32 per sample per channel. */
function audioBufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

/**
 * How much decoded PCM may sit in memory at once.
 *
 * Decoded audio is by far the heaviest thing the editor holds: 48 kHz stereo
 * float is ~23 MB per minute. What bounds it now is the segment grid - nothing
 * ever decodes more of a source than the window being played - and this budget
 * is what decides how much of that window is KEPT once the playhead has moved
 * on, so scrubbing back over a cut does not decode it again.
 *
 * The budget itself, and what it is derived from, live in `audioMemory.ts`.
 * Read once - the machine does not change mid-session, and a budget that moved
 * under the eviction policy would be its own bug.
 *
 * Every entry is reconstructible by re-decoding the source, so eviction costs
 * time, never data - the same rule the transcoded-audio cache is built on.
 */
let budget: number | null = null;

/**
 * The budget this cache is actually enforcing, memoized. Exported alongside
 * `cachedAudioBytes` so a test can compare the two without re-deriving the
 * number from the machine and hoping it lands on the same one.
 */
export function audioBudgetBytes(): number {
  budget ??= audioCacheBudgetBytes(readMemoryEnv());
  return budget;
}

/** Bytes currently held by resolved entries. Exported for the memory tests. */
export function cachedAudioBytes(): number {
  let total = 0;
  for (const entry of audioEntries.values()) total += entry.bytes;
  return total;
}

/**
 * Which keys have to go for the cache to fit in `target`, and nothing more.
 *
 * Pure and exported for its own sake, exactly like `selectEvictions` in the
 * on-disk cache: this is where the policy lives, and testing it through real
 * AudioBuffers would test the browser's decoder rather than the ranking.
 *
 * `keep` is the entry the caller has just resolved - evicting it would make the
 * decode that triggered this pointless, and the very next request would redo it.
 */
export function selectAudioEvictions(
  entries: Iterable<readonly [string, { bytes: number; lastUsedAt: number; pinned: boolean }]>,
  target: number,
  keep?: string,
): string[] {
  const all = [...entries];
  let total = 0;
  for (const [, entry] of all) total += entry.bytes;
  if (total <= target) return [];

  const candidates = all
    // An in-flight decode has nothing to free, and dropping the memo would only
    // start a second decode of the same segment alongside the first.
    .filter(([key, entry]) => key !== keep && entry.bytes > 0)
    // Least-recently-used within each tier, unpinned tier first: a pinned entry
    // is simply last in line, and is only reached when dropping every unpinned
    // one was not enough.
    .sort(([, a], [, b]) =>
      a.pinned !== b.pinned ? Number(a.pinned) - Number(b.pinned) : a.lastUsedAt - b.lastUsedAt,
    );

  const doomed: string[] = [];
  for (const [key, entry] of candidates) {
    if (total <= target) break;
    doomed.push(key);
    total -= entry.bytes;
  }
  return doomed;
}

function enforceAudioBudget(keep?: string): void {
  for (const key of selectAudioEvictions(audioEntries, audioBudgetBytes(), keep)) {
    audioEntries.delete(key);
  }
}

/**
 * Decodes of one track run one after another.
 *
 * Every segment decode opens its own decoder and seeks: a window needing three
 * of them at once would run three decoders over one demuxer, which is both
 * slower and more memory than doing them in turn. Queued PER TRACK, so two
 * different sources still decode in parallel - a stacked cut needs both, and
 * serializing everything globally would make the second one wait on the first
 * for no reason.
 */
const decodeQueues = new Map<string, Promise<unknown>>();

function enqueueDecode<T>(queueKey: string, run: () => Promise<T>): Promise<T> {
  const previous = decodeQueues.get(queueKey) ?? Promise.resolve();
  // Same `run` on both settlements: a failed decode must not stall the queue.
  const next = previous.then(run, run);
  decodeQueues.set(
    queueKey,
    next.catch(() => {}),
  );
  return next;
}

/**
 * One segment of one audio track, decoded once and shared by every clip that
 * reads that part of the source.
 *
 * `audioTrackIndex` selects a track of a multi-track source. An evicted segment
 * simply decodes again on its next request. Callers holding the buffer (the
 * preview's scheduled sources, an export slice being rendered) keep it alive
 * through their own reference: eviction drops the cache's claim on it, never
 * the buffer out from under whoever is using it.
 */
export function getAudioSegment(
  asset: MediaAsset,
  audioTrackIndex: number | undefined,
  index: number,
): Promise<AudioSegment | null> {
  const key = segmentCacheKey(asset.id, audioTrackIndex, index);
  const existing = audioEntries.get(key);
  if (existing) {
    existing.lastUsedAt = ++useStamp;
    return existing.promise;
  }
  const entry: AudioEntry = {
    promise: enqueueDecode(audioKey(asset.id, audioTrackIndex), () =>
      decodeGuarded(asset, audioTrackIndex, index, key),
    ),
    value: null,
    bytes: 0,
    lastUsedAt: ++useStamp,
    pinned: false,
  };
  audioEntries.set(key, entry);
  void entry.promise.then((segment) => {
    // The entry can have been dropped while decoding (asset removed, or the
    // budget swept it): sizing a record nobody holds would resurrect it.
    if (segment && audioEntries.get(key) === entry) {
      entry.value = segment;
      entry.bytes = audioBufferBytes(segment.buffer);
      enforceAudioBudget(key);
    }
  });
  return entry.promise;
}

/**
 * Every segment covering a source time range, decoded.
 *
 * Missing segments (a range past the end of the source, a decode that failed)
 * are simply absent from the result - the caller renders the silence rather
 * than the whole range failing.
 */
export async function getAudioRange(
  asset: MediaAsset,
  audioTrackIndex: number | undefined,
  fromMs: number,
  toMs: number,
): Promise<AudioSegment[]> {
  const segments = await Promise.all(
    segmentIndexes(fromMs, toMs).map((index) => getAudioSegment(asset, audioTrackIndex, index)),
  );
  return segments.filter((segment): segment is AudioSegment => segment !== null);
}

/**
 * Start decoding a range without waiting for it. What the preview calls ahead
 * of the playhead: by the time the window is scheduled the segments are there,
 * and a late one is picked up by a later scheduling pass.
 */
export function prefetchAudioRange(
  asset: MediaAsset,
  audioTrackIndex: number | undefined,
  fromMs: number,
  toMs: number,
): void {
  for (const index of segmentIndexes(fromMs, toMs)) {
    void getAudioSegment(asset, audioTrackIndex, index).catch(() => null);
  }
}

/**
 * What is decoded RIGHT NOW for a source range, without asking for anything.
 *
 * Synchronous because the mix scheduler runs inside a rAF tick and inside an
 * OfflineAudioContext render: both have to answer "what can I play" without
 * awaiting. Marks what it returns as used, so playing a region is what keeps it
 * in the cache.
 */
export function peekAudioRange(
  assetId: string,
  audioTrackIndex: number | undefined,
  fromMs: number,
  toMs: number,
): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const index of segmentIndexes(fromMs, toMs)) {
    const entry = audioEntries.get(segmentCacheKey(assetId, audioTrackIndex, index));
    if (!entry?.value) continue;
    entry.lastUsedAt = ++useStamp;
    out.push(entry.value);
  }
  return out;
}

/**
 * One decode, with the one failure that is worth naming pulled out of the
 * anonymous `catch` everything else lands in.
 *
 * An allocation failure used to resolve to null like any other problem: the
 * clip went silent, no message was shown, and an export produced a video whose
 * sound was simply missing. It gets one retry, because the common shape of the
 * failure is not "this segment is impossible" but "this segment plus everything
 * already cached is" - and everything already cached is reconstructible.
 */
async function decodeGuarded(
  asset: MediaAsset,
  audioTrackIndex: number | undefined,
  index: number,
  key: string,
): Promise<AudioSegment | null> {
  try {
    return await decodeSegment(asset, audioTrackIndex, index);
  } catch (err) {
    if (!(err instanceof AudioMemoryError)) return null;
    releaseReclaimable(key);
    try {
      return await decodeSegment(asset, audioTrackIndex, index);
    } catch (retryErr) {
      reportAudioMemory(asset, retryErr instanceof AudioMemoryError ? retryErr : err);
      return null;
    }
  }
}

/**
 * Drop every entry that can simply be decoded again, keeping `keep`.
 *
 * Deliberately not `enforceAudioBudget(0)`: that would take the pinned
 * transcoded PCM with it, and re-creating one of those is a minutes-long ffmpeg
 * conversion where re-decoding costs seconds. Freeing room for a decode must
 * not cost more than the decode it rescues.
 */
function releaseReclaimable(keep: string): void {
  for (const [key, entry] of [...audioEntries]) {
    if (key !== keep && !entry.pinned) audioEntries.delete(key);
  }
}

/**
 * Problems already reported, so the preview loop cannot say the same thing
 * sixty times a second. Same reasoning as `errorSignature` in `app/errorPolicy`.
 */
const reportedMemoryFailures = new Set<string>();

/**
 * Say it, once, in the user's language.
 *
 * The store and i18n are reached by dynamic import rather than from the top of
 * the module. This is a cold path that runs at most once per track, both
 * modules are already resident in the running app, and keeping the UI layer out
 * of this module's import graph is what lets the decode caches be unit-tested
 * without a DOM. Console first, so the detail survives even if the toast does
 * not.
 */
function reportAudioMemory(asset: MediaAsset, err: AudioMemoryError): void {
  const key = `${asset.id}#${err.trackIndex ?? 'p'}`;
  if (reportedMemoryFailures.has(key)) return;
  reportedMemoryFailures.add(key);
  console.warn('[mediaCache]', err);
  void (async () => {
    try {
      const [{ useStore }, i18n] = await Promise.all([import('../store/store'), import('../i18n')]);
      const size = formatBytes(err.estimatedBytes, i18n.default.language);
      // The track number only helps when there is more than one to tell apart.
      const message =
        asset.audioTracks.length > 1 && err.trackIndex != null
          ? i18n.t('errors.audio.outOfMemoryTrack', {
              name: asset.file.name,
              track: err.trackIndex + 1,
              size,
            })
          : i18n.t('errors.audio.outOfMemory', { name: asset.file.name, size });
      useStore.getState().setError(message);
    } catch {
      /* the reporter must never be the thing that breaks a decode */
    }
  })();
}

/**
 * Trailing slack on the last segment of a source.
 *
 * A container's stated duration and what its packets actually carry disagree by
 * a frame or two often enough to matter, and the disagreement is always at the
 * end. Half a second of room costs nothing and is the difference between the
 * last word of a take and most of it.
 */
const SOURCE_SLACK_MS = 500;

/**
 * Decode one segment of one track into a single AudioBuffer.
 *
 * The buffer covers exactly `[index * SEGMENT_MS, +SEGMENT_MS)` of SOURCE time,
 * clipped to what the source has left, so its frame 0 is always at a known
 * timestamp - which is what lets a clip be scheduled from pieces without any of
 * them knowing about clips.
 */
async function decodeSegment(
  asset: MediaAsset,
  audioTrackIndex: number | undefined,
  index: number,
): Promise<AudioSegment | null> {
  if (!asset.hasAudio) return null;
  const startMs = segmentStartMs(index);
  // Entirely past the end of the source: nothing to decode, and a memoized null
  // here is what stops a clip trimmed past its media from asking again.
  const spanMs = Math.min(SEGMENT_MS, asset.durationMs + SOURCE_SLACK_MS - startMs);
  if (spanMs <= 0) return null;

  const input = await getInput(asset);
  const track = await resolveAudioTrack(input, audioTrackIndex);
  if (!track || !(await track.canDecode())) return null;

  const { AudioBufferSink } = await mediabunny();
  const sink = new AudioBufferSink(track);
  const sampleRate = track.sampleRate;
  const numberOfChannels = Math.max(1, track.numberOfChannels);
  const frames = Math.ceil((spanMs / 1000) * sampleRate);
  const startSec = startMs / 1000;
  const endSec = (startMs + spanMs) / 1000;

  let target: AudioBuffer;
  try {
    target = new AudioBuffer({ length: frames, numberOfChannels, sampleRate });
  } catch (err) {
    if (!isAllocationFailure(err)) throw err;
    throw new AudioMemoryError(asset.file.name, audioTrackIndex, frames * numberOfChannels * 4, {
      cause: err,
    });
  }

  // `buffers(start, end)` yields the last packet starting at or before `start`,
  // so the piece is covered from its very first sample: that packet begins
  // BEFORE this segment and is copied from the right offset into it.
  let wrote = false;
  for await (const wrapped of sink.buffers(startSec, endSec)) {
    const offset = Math.round((wrapped.timestamp - startSec) * sampleRate);
    if (offset >= frames) break;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const srcCh = Math.min(ch, wrapped.buffer.numberOfChannels - 1);
      let data = wrapped.buffer.getChannelData(srcCh);
      let at = offset;
      if (at < 0) {
        if (-at >= data.length) continue;
        data = data.subarray(-at);
        at = 0;
      }
      const room = frames - at;
      if (room <= 0) continue;
      target.copyToChannel(room < data.length ? data.subarray(0, room) : data, ch, at);
      wrote = true;
    }
  }
  // Nothing at all landed here: a hole in the source, or a range past its real
  // end. Holding 30 s of silence for that would be the cache paying for it.
  return wrote ? { buffer: target, startMs, index } : null;
}

/** How much of a track's head a warm decodes: enough to cover pressing play. */
const WARM_SEGMENTS = 1;

/**
 * Decode the head of every playable track right after import.
 *
 * Only the head: a warm is a head start on pressing play, not a reason to hold
 * a file the user may never touch. Everything past it arrives from the
 * preview's own prefetch as the playhead approaches it.
 */
export function warmAudio(asset: MediaAsset): void {
  const warm = (audioTrackIndex?: number) => {
    for (let index = 0; index < WARM_SEGMENTS; index++) {
      // Skipped rather than queued when the cache is already full: a warm is
      // speculation, so it is the first thing to give up when memory is tight.
      if (cachedAudioBytes() >= audioBudgetBytes()) return;
      void getAudioSegment(asset, audioTrackIndex, index).catch(() => null);
    }
  };
  if (asset.audioTracks.length === 0) {
    if (asset.hasAudio) warm();
    return;
  }
  // Undecodable tracks would only decode to null: they wait for an explicit
  // transcode, which fills the cache through setTranscodedAudio.
  for (const track of asset.audioTracks) {
    if (isTrackPlayable(track)) warm(track.index);
  }
}

/**
 * Publish the PCM produced by an on-demand transcode as if the browser had
 * decoded the track natively. Everything downstream (preview mix, export,
 * waveform) reads the cache, so this single injection makes the track audible
 * everywhere without any of them knowing a transcode happened.
 *
 * Sliced onto the same grid as a normal decode: the mix only ever asks for
 * segments, so a transcode publishing one long buffer would be inaudible. The
 * slices are pinned - unlike a decode, this PCM cannot be reconstructed by
 * asking the browser again, and the only way back is the minutes-long
 * conversion that produced it.
 *
 * Peaks are re-derived from the buffer here because `streamPeaks` decodes
 * through mediabunny, which is exactly what cannot handle this track.
 */
export function setTranscodedAudio(
  assetId: string,
  audioTrackIndex: number,
  buffer: AudioBuffer,
  { alsoPrimary = false }: { alsoPrimary?: boolean } = {},
): number[] {
  const peaks = peaksFromBuffer(buffer);
  // A clip that pins no track reads the cache under the "primary" key, which is
  // deliberately distinct from '#0'. When this IS the source's only track, the
  // two address the same sound, so publish under both or such a clip (any
  // audio-only import) would stay silent after its transcode.
  const tracks: (number | undefined)[] = alsoPrimary
    ? [audioTrackIndex, undefined]
    : [audioTrackIndex];
  const durationMs = (buffer.length / buffer.sampleRate) * 1000;
  let lastKey = '';
  for (const track of tracks) {
    for (const index of segmentIndexes(0, durationMs)) {
      const segment = sliceSegment(buffer, index);
      if (!segment) continue;
      lastKey = segmentCacheKey(assetId, track, index);
      audioEntries.set(lastKey, {
        promise: Promise.resolve(segment),
        value: segment,
        bytes: audioBufferBytes(segment.buffer),
        lastUsedAt: ++useStamp,
        pinned: true,
      });
    }
    peaksPromises.set(audioKey(assetId, track), Promise.resolve(peaks));
  }
  // Every slice is in before the budget is asked to rank them: sweeping between
  // two of them could drop one half of a track that was just published whole.
  enforceAudioBudget(lastKey);
  return peaks;
}

/** Copy one grid-aligned piece out of a whole-track buffer. */
function sliceSegment(buffer: AudioBuffer, index: number): AudioSegment | null {
  const startMs = segmentStartMs(index);
  const from = Math.round((startMs / 1000) * buffer.sampleRate);
  if (from >= buffer.length) return null;
  const frames = Math.min(Math.round((SEGMENT_MS / 1000) * buffer.sampleRate), buffer.length - from);
  const target = new AudioBuffer({
    length: frames,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    target.copyToChannel(buffer.getChannelData(ch).subarray(from, from + frames), ch, 0);
  }
  return { buffer: target, startMs, index };
}

/** Same normalized envelope as `streamPeaks`, computed from an in-memory buffer. */
function peaksFromBuffer(buffer: AudioBuffer): number[] {
  const durationMs = (buffer.length / buffer.sampleRate) * 1000;
  const bins = expectedPeakBins(durationMs);
  const out = new Array<number>(bins).fill(0);
  const data = buffer.getChannelData(0);
  const stride = Math.max(1, Math.floor(data.length / bins / SAMPLES_PER_BIN));
  for (let j = 0; j < data.length; j += stride) {
    const bin = Math.floor((j / data.length) * bins);
    if (bin < 0 || bin >= bins) continue;
    const v = Math.abs(data[j]!);
    if (v > out[bin]!) out[bin] = v;
  }
  return normalize(out);
}

/**
 * Samples read per bin. Decimating harder is cheaper but keeps missing the
 * actual peak inside the bin, which reads as a jittery envelope rather than a
 * smooth one.
 */
const SAMPLES_PER_BIN = 64;

const peaksPromises = new Map<string, Promise<number[] | null>>();

/**
 * Peak resolution: 150 bins per second. The waveform interpolates between bins,
 * so this sets how much real detail exists rather than where stair-stepping
 * starts - but below ~100 bins/s the envelope visibly smooths away transients
 * at the zoom levels used for cutting on beats.
 *
 * The cap keeps hour-long footage from dominating the project file; peaks are
 * serialized (see `projectFile.ts`), rounded to 3 decimals by `normalize`.
 */
export function expectedPeakBins(durationMs: number): number {
  return Math.round(Math.min(200000, Math.max(200, (durationMs / 1000) * 150)));
}

/**
 * Scale an envelope to 0..1 in place, rounded to 3 decimals - full float
 * precision is invisible on a 64px-tall bar and triples the serialized size.
 */
function normalize(out: number[]): number[] {
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] = Math.round((out[i]! / max) * 1000) / 1000;
  return out;
}

/** Normalized waveform peaks (0..1) across the asset's duration (memoized per track). */
export function getPeaks(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<number[] | null> {
  const key = audioKey(asset.id, audioTrackIndex);
  let promise = peaksPromises.get(key);
  if (!promise) {
    promise = streamPeaks(asset, audioTrackIndex).catch(() => null);
    peaksPromises.set(key, promise);
  }
  return promise;
}

/**
 * Compute peaks by streaming decoded chunks - never materializes the full
 * AudioBuffer, so hour-long footage works without a 100s-of-MB allocation.
 */
async function streamPeaks(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<number[] | null> {
  if (!asset.hasAudio) return null;
  const input = await getInput(asset);
  const track = await resolveAudioTrack(input, audioTrackIndex);
  if (!track || !(await track.canDecode())) return null;

  const { AudioBufferSink } = await mediabunny();
  const sink = new AudioBufferSink(track);
  const durationSec = asset.durationMs / 1000;
  const bins = expectedPeakBins(asset.durationMs);
  const out = new Array<number>(bins).fill(0);

  for await (const wrapped of sink.buffers()) {
    const data = wrapped.buffer.getChannelData(0);
    const sr = wrapped.buffer.sampleRate;
    // Sampling every few frames is plenty for a visual envelope.
    const stride = Math.max(1, Math.floor(((durationSec / bins) * sr) / SAMPLES_PER_BIN));
    for (let j = 0; j < data.length; j += stride) {
      const bin = Math.floor(((wrapped.timestamp + j / sr) / durationSec) * bins);
      if (bin < 0 || bin >= bins) continue;
      const v = Math.abs(data[j]!);
      if (v > out[bin]!) out[bin] = v;
    }
  }

  return normalize(out);
}
