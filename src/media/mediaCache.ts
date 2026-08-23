import type { Input, InputAudioTrack } from 'mediabunny';
import { mediabunny } from './mediabunnyModule';
import { MediaAsset, isTrackPlayable } from '../types';
import { StillFrame, decodeImageFile } from './stillImage';
import {
  AudioMemoryError,
  audioCacheBudgetBytes,
  decodedTrackBytes,
  formatBytes,
  isAllocationFailure,
  readMemoryEnv,
  trackDecodeCapBytes,
} from './audioMemory';

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
 * One memoized decode of a single audio track, plus what the budget below needs
 * to rank it. `bytes` is 0 until the decode resolves - an in-flight entry cannot
 * be sized, and evicting it would not free anything anyway.
 */
interface AudioEntry {
  promise: Promise<AudioBuffer | null>;
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

const audioEntries = new Map<string, AudioEntry>();

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
 * float is ~23 MB per minute, so a batch import of a dozen ten-minute gameplay
 * captures used to pin ~2.7 GB before the user had touched anything. Nothing
 * ever released it (the map was a plain memo, keyed forever), and the first
 * large allocation after that - the export's output buffer, the offline mix -
 * failed outright with "Array buffer allocation failed".
 *
 * The budget itself, and what it is derived from, live in `audioMemory.ts`:
 * the import path needs the same numbers before any of this runs, to say what
 * a file is about to cost. Read once - the machine does not change mid-session,
 * and a budget that moved under the eviction policy would be its own bug.
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
    // start a second decode of the same track alongside the first.
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
 * Decode one audio track of an asset into a single AudioBuffer (memoized per
 * track, under the budget above). `audioTrackIndex` selects a track of a
 * multi-track source.
 *
 * An evicted track simply decodes again on its next request. Callers that are
 * holding the buffer (the preview's scheduled sources, an export mix being
 * assembled) keep it alive through their own reference: eviction drops the
 * cache's claim on it, never the buffer out from under whoever is using it.
 */
export function getAudioBuffer(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<AudioBuffer | null> {
  const key = audioKey(asset.id, audioTrackIndex);
  const existing = audioEntries.get(key);
  if (existing) {
    existing.lastUsedAt = ++useStamp;
    return existing.promise;
  }
  const entry: AudioEntry = {
    promise: decodeGuarded(asset, audioTrackIndex, key),
    bytes: 0,
    lastUsedAt: ++useStamp,
    pinned: false,
  };
  audioEntries.set(key, entry);
  void entry.promise.then((buffer) => {
    // The entry can have been dropped while decoding (asset removed, or the
    // budget swept it): sizing a record nobody holds would resurrect it.
    if (buffer && audioEntries.get(key) === entry) {
      entry.bytes = audioBufferBytes(buffer);
      enforceAudioBudget(key);
    }
  });
  return entry.promise;
}

/**
 * One decode, with the one failure that is worth naming pulled out of the
 * anonymous `catch` everything else lands in.
 *
 * An allocation failure used to resolve to null like any other problem: the
 * clip went silent, no message was shown, and an export produced a video whose
 * sound was simply missing. It gets one retry, because the common shape of the
 * failure is not "this track is impossible" but "this track plus everything
 * already cached is" - and everything already cached is reconstructible.
 */
async function decodeGuarded(
  asset: MediaAsset,
  audioTrackIndex: number | undefined,
  key: string,
): Promise<AudioBuffer | null> {
  try {
    return await decodeFullAudio(asset, audioTrackIndex);
  } catch (err) {
    if (!(err instanceof AudioMemoryError)) return null;
    releaseReclaimable(key);
    try {
      return await decodeFullAudio(asset, audioTrackIndex);
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

async function decodeFullAudio(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<AudioBuffer | null> {
  if (!asset.hasAudio) return null;
  const input = await getInput(asset);
  const track = await resolveAudioTrack(input, audioTrackIndex);
  if (!track || !(await track.canDecode())) return null;

  const { AudioBufferSink } = await mediabunny();
  const sink = new AudioBufferSink(track);
  const sampleRate = track.sampleRate;
  const numberOfChannels = Math.max(1, track.numberOfChannels);
  const totalFrames = Math.ceil((asset.durationMs / 1000) * sampleRate) + sampleRate;
  // The whole track in one object: this is the allocation that fails, and the
  // only place where the browser's refusal can still be attributed to a file
  // and a track rather than surfacing as a bare RangeError from nowhere.
  let target: AudioBuffer;
  try {
    target = new AudioBuffer({ length: totalFrames, numberOfChannels, sampleRate });
  } catch (err) {
    if (!isAllocationFailure(err)) throw err;
    throw new AudioMemoryError(
      asset.file.name,
      audioTrackIndex,
      totalFrames * numberOfChannels * 4,
      { cause: err },
    );
  }

  for await (const wrapped of sink.buffers()) {
    const offset = Math.round(wrapped.timestamp * sampleRate);
    if (offset < 0 || offset >= totalFrames) continue;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const srcCh = Math.min(ch, wrapped.buffer.numberOfChannels - 1);
      const data = wrapped.buffer.getChannelData(srcCh);
      const room = totalFrames - offset;
      target.copyToChannel(room < data.length ? data.subarray(0, room) : data, ch, offset);
    }
  }
  return target;
}

/**
 * Warm decodes run one after another, and only while the cache has room.
 *
 * Both halves matter for a batch import. Concurrently, a dozen files decoded at
 * once turned the import into a several-second freeze and allocated every
 * buffer before a single one could be ranked for eviction. Unconditionally, the
 * warm pass filled the cache with footage the user may never play, evicting
 * whatever they were actually working on - a warm is a head start, so it is the
 * first thing to give up when memory is tight rather than the last.
 */
let warmQueue: Promise<unknown> = Promise.resolve();

function queueWarm(asset: MediaAsset, audioTrackIndex?: number): void {
  warmQueue = warmQueue.then(async () => {
    // Re-checked here, not when queued: the entries ahead in the queue are what
    // fills the cache, so the decision is only meaningful at its turn.
    if (cachedAudioBytes() >= audioBudgetBytes()) return;
    await getAudioBuffer(asset, audioTrackIndex);
  }, () => {});
}

/**
 * Whether a track is small enough to decode on speculation.
 *
 * Over the cap, a decode is one allocation large enough to be the reason the
 * next one fails, and warming is speculation by definition - the user has not
 * asked for this track yet. Putting the clip on the timeline is the moment they
 * do, and `getAudioBuffer` still decodes it then: this only declines to spend
 * the memory before being asked. The import path warns with the same numbers,
 * so what is announced and what happens are the same decision.
 */
function warmable(asset: MediaAsset, track?: { sampleRate?: number; channels?: number }): boolean {
  return decodedTrackBytes(asset.durationMs, track ?? {}) <= trackDecodeCapBytes(audioBudgetBytes());
}

/** Kick off background audio decoding (every playable audio track) right after import. */
export function warmAudio(asset: MediaAsset): void {
  if (asset.audioTracks.length === 0) {
    if (asset.hasAudio && warmable(asset)) queueWarm(asset);
    return;
  }
  // Undecodable tracks would only decode to null: they wait for an explicit
  // transcode, which fills the cache through setTranscodedAudio.
  for (const track of asset.audioTracks) {
    if (isTrackPlayable(track) && warmable(asset, track)) queueWarm(asset, track.index);
  }
}

/**
 * Publish the PCM produced by an on-demand transcode as if the browser had
 * decoded the track natively. Everything downstream (preview mix, export,
 * waveform) reads the cache, so this single injection makes the track audible
 * everywhere without any of them knowing a transcode happened.
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
  const keys = alsoPrimary
    ? [audioKey(assetId, audioTrackIndex), audioKey(assetId)]
    : [audioKey(assetId, audioTrackIndex)];
  for (const key of keys) {
    // Pinned: unlike a decode, this PCM cannot be reconstructed by asking the
    // browser again - the track is undecodable, and the only way back is the
    // minutes-long transcode that produced it.
    audioEntries.set(key, {
      promise: Promise.resolve(buffer),
      bytes: audioBufferBytes(buffer),
      lastUsedAt: ++useStamp,
      pinned: true,
    });
    peaksPromises.set(key, Promise.resolve(peaks));
  }
  // Both keys address the same buffer, so it is counted twice above; the budget
  // pass runs once, after both are in.
  enforceAudioBudget(keys[0]);
  return peaks;
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
