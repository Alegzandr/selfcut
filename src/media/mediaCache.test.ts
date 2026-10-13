import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AssetDisposedError,
  assetGeneration,
  disposeAssetResources,
  getAudioSegment,
  getInput,
  peekAudioRange,
  selectAudioEvictions,
  setTranscodedAudio,
} from './mediaCache';
// The budget it is measured against is pure: see audioMemory.test.ts.
import { audioCacheBudgetBytes } from './audioMemory';
import type { MediaAsset } from '../types';

/** Just enough of an AudioBuffer for the cache: planar f32 channels. */
class FakeAudioBuffer {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];
  constructor(o: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = o.length;
    this.numberOfChannels = o.numberOfChannels;
    this.sampleRate = o.sampleRate;
    this.channels = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length));
  }
  getChannelData(ch: number): Float32Array {
    return this.channels[ch]!;
  }
  copyToChannel(src: Float32Array, ch: number, at = 0): void {
    this.channels[ch]!.set(src, at);
  }
}

beforeAll(() => vi.stubGlobal('AudioBuffer', FakeAudioBuffer));
afterAll(() => vi.unstubAllGlobals());

/** 70 s of stereo at 100 Hz: three 30 s segments; sample i is i (L) and -i (R). */
function rampBuffer(): AudioBuffer {
  const buffer = new FakeAudioBuffer({ length: 7000, numberOfChannels: 2, sampleRate: 100 });
  for (let i = 0; i < buffer.length; i++) {
    buffer.getChannelData(0)[i] = i;
    buffer.getChannelData(1)[i] = -i;
  }
  return buffer as unknown as AudioBuffer;
}

const audioAsset = (id: string): MediaAsset => ({
  id,
  file: new File([], `${id}.mka`),
  kind: 'audio',
  durationMs: 70_000,
  hasAudio: true,
  audioTracks: [{ index: 0, channels: 2, transcoded: true }],
  thumbnails: [],
});

describe('setTranscodedAudio', () => {
  it('reads any segment back from the transcoded copy, not the decoder', async () => {
    setTranscodedAudio('t1', 0, rampBuffer());
    // Segment 1 was never sliced eagerly: it comes from the stored PCM.
    expect(peekAudioRange('t1', 0, 30_000, 31_000)).toEqual([]);
    const segment = await getAudioSegment(audioAsset('t1'), 0, 1);
    expect(segment?.startMs).toBe(30_000);
    expect(segment?.buffer.length).toBe(3000);
    expect(segment?.buffer.getChannelData(0)[0]).toBe(3000);
    expect(segment?.buffer.getChannelData(1)[2999]).toBe(-5999);
    // Last, short segment.
    const tail = await getAudioSegment(audioAsset('t1'), 0, 2);
    expect(tail?.buffer.length).toBe(1000);
    expect(tail?.buffer.getChannelData(0)[999]).toBe(6999);
    // And now resident for the synchronous mix.
    expect(peekAudioRange('t1', 0, 30_000, 31_000)).toEqual([segment]);
    disposeAssetResources('t1');
  });

  it('serves the primary key from the same buffers as the track (no second copy)', async () => {
    setTranscodedAudio('t2', 0, rampBuffer(), { alsoPrimary: true });
    const [head] = peekAudioRange('t2', 0, 0, 1000);
    expect(head).toBeDefined();
    expect(peekAudioRange('t2', undefined, 0, 1000)[0]).toBe(head);
    const viaPrimary = await getAudioSegment(audioAsset('t2'), undefined, 1);
    expect(await getAudioSegment(audioAsset('t2'), 0, 1)).toBe(viaPrimary);
    disposeAssetResources('t2');
  });

  it('forgets everything about the asset once disposed', () => {
    setTranscodedAudio('t3', 0, rampBuffer(), { alsoPrimary: true });
    disposeAssetResources('t3');
    expect(peekAudioRange('t3', 0, 0, 1000)).toEqual([]);
    expect(peekAudioRange('t3', undefined, 0, 1000)).toEqual([]);
  });
});

describe('getInput after disposal', () => {
  it('refuses work started under an older generation instead of re-creating an Input', async () => {
    const asset = audioAsset('g1');
    const before = assetGeneration('g1');
    disposeAssetResources('g1');
    expect(assetGeneration('g1')).toBe(before + 1);
    await expect(getInput(asset, before)).rejects.toBeInstanceOf(AssetDisposedError);
  });
});

type Entry = { bytes: number; lastUsedAt: number; pinned: boolean };

const entry = (bytes: number, lastUsedAt: number, pinned = false): Entry => ({
  bytes,
  lastUsedAt,
  pinned,
});

describe('selectAudioEvictions', () => {
  it('evicts nothing while the cache fits', () => {
    const entries: [string, Entry][] = [
      ['a#0', entry(100, 1)],
      ['b#0', entry(100, 2)],
    ];
    expect(selectAudioEvictions(entries, 200)).toEqual([]);
  });

  it('drops least-recently-used entries until it fits, and no more', () => {
    const entries: [string, Entry][] = [
      ['a#0', entry(100, 3)],
      ['b#0', entry(100, 1)],
      ['c#0', entry(100, 2)],
    ];
    // 300 held, 150 allowed: b (oldest) then c is enough - a survives.
    expect(selectAudioEvictions(entries, 150)).toEqual(['b#0', 'c#0']);
  });

  it('ranks transcoded PCM last: it cannot be re-decoded, only re-converted', () => {
    const entries: [string, Entry][] = [
      ['transcoded#0', entry(100, 1, true)],
      ['plain#0', entry(100, 9)],
    ];
    // The pinned entry is by far the oldest and still outlives the fresh one.
    expect(selectAudioEvictions(entries, 100)).toEqual(['plain#0']);
  });

  it('falls through to pinned entries rather than failing to free anything', () => {
    const entries: [string, Entry][] = [
      ['t1#0', entry(100, 1, true)],
      ['t2#0', entry(100, 2, true)],
    ];
    expect(selectAudioEvictions(entries, 100)).toEqual(['t1#0']);
  });

  it('never evicts the entry that just resolved', () => {
    const entries: [string, Entry][] = [
      ['fresh#0', entry(100, 1)],
      ['old#0', entry(100, 0)],
    ];
    // `fresh` is what the budget pass was triggered by: dropping it would make
    // the decode pointless and the next request would immediately redo it.
    expect(selectAudioEvictions(entries, 100, 'fresh#0')).toEqual(['old#0']);
  });

  it('ignores decodes still in flight - they have nothing to free yet', () => {
    const entries: [string, Entry][] = [
      ['pending#0', entry(0, 0)],
      ['done#0', entry(300, 1)],
    ];
    expect(selectAudioEvictions(entries, 100)).toEqual(['done#0']);
  });

  it('bounds a batch import that would otherwise pin gigabytes', () => {
    // Twelve ten-minute stereo captures: ~230 MB of decoded PCM each, which is
    // what used to sit in memory untouched until the tab ran out.
    const perClip = 10 * 60 * 48_000 * 2 * 4;
    const entries: [string, Entry][] = Array.from({ length: 12 }, (_, i) => [
      `asset-${i}#0`,
      entry(perClip, i),
    ]);
    const budget = audioCacheBudgetBytes({ deviceMemoryGb: 8 });
    const doomed = new Set(selectAudioEvictions(entries, budget));
    const remaining = entries
      .filter(([key]) => !doomed.has(key))
      .reduce((sum, [, e]) => sum + e.bytes, 0);
    expect(remaining).toBeLessThanOrEqual(budget);
    // And the survivors are the most recent ones, not an arbitrary prefix.
    expect(doomed.has('asset-11#0')).toBe(false);
    expect(doomed.has('asset-0#0')).toBe(true);
  });
});
