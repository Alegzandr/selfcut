import { describe, expect, it } from 'vitest';
import type { AudioTrackInfo } from '../types';
import {
  AudioMemoryError,
  DEFAULT_SAMPLE_RATE,
  audioCacheBudgetBytes,
  decodedTrackBytes,
  estimateAssetBytes,
  estimateAudioTracks,
  isAllocationFailure,
  trackDecodeCapBytes,
} from './audioMemory';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MINUTE = 60_000;

const stereo = { sampleRate: 48_000, channels: 2 };

describe('decodedTrackBytes', () => {
  it('matches the buffer decodeFullAudio actually allocates', () => {
    // frames = ceil(duration x rate) + one second of slack, f32 per channel.
    const frames = Math.ceil(90 * 48_000) + 48_000;
    expect(decodedTrackBytes(90_000, stereo)).toBe(frames * 2 * 4);
  });

  it('lands on the ~23 MB per stereo minute the decode strategy is costed at', () => {
    const perMinute = decodedTrackBytes(MINUTE, stereo) - decodedTrackBytes(0, stereo);
    expect(Math.round(perMinute / 1e6)).toBe(23);
  });

  it('scales with the channel count: a 5.1 track is three stereo tracks', () => {
    expect(decodedTrackBytes(MINUTE, { sampleRate: 48_000, channels: 6 })).toBe(
      decodedTrackBytes(MINUTE, stereo) * 3,
    );
  });

  it('assumes 48 kHz when the container states no rate', () => {
    // Assets probed before `sampleRate` was recorded have none, and guessing low
    // would under-estimate the very thing the guard exists to bound.
    expect(decodedTrackBytes(MINUTE, { channels: 2 })).toBe(
      decodedTrackBytes(MINUTE, { sampleRate: DEFAULT_SAMPLE_RATE, channels: 2 }),
    );
  });

  it('never returns a negative size for a nonsense duration', () => {
    expect(decodedTrackBytes(-5000, stereo)).toBe(48_000 * 2 * 4);
  });
});

describe('estimateAudioTracks', () => {
  const track = (index: number, extra: Partial<AudioTrackInfo> = {}): AudioTrackInfo => ({
    index,
    channels: 2,
    sampleRate: 48_000,
    ...extra,
  });

  it('sizes every playable track, keyed by the index a clip stores', () => {
    expect(estimateAudioTracks(MINUTE, [track(0), track(1)])).toEqual([
      { index: 0, bytes: decodedTrackBytes(MINUTE, stereo) },
      { index: 1, bytes: decodedTrackBytes(MINUTE, stereo) },
    ]);
  });

  it('skips a track no browser can decode', () => {
    // It decodes to nothing until an explicit transcode, which is a different
    // path with its own cache: counting it here would inflate every rip.
    const tracks = [track(0), track(1, { undecodable: true })];
    expect(estimateAudioTracks(MINUTE, tracks).map((t) => t.index)).toEqual([0]);
  });

  it('counts an undecodable track once it has been transcoded this session', () => {
    const tracks = [track(0, { undecodable: true, transcoded: true })];
    expect(estimateAssetBytes(MINUTE, tracks)).toBe(decodedTrackBytes(MINUTE, stereo));
  });
});

describe('audioCacheBudgetBytes', () => {
  it('takes a fifth of the RAM the machine reports, between a floor and a ceiling', () => {
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 4 })).toBe(Math.round(0.8 * GB));
    // deviceMemory is capped at 8 by the spec; the ceiling is ours.
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 8 })).toBe(1024 * MB);
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 64 })).toBe(1024 * MB);
    // A tiny machine still gets enough for a track: the cache exists precisely
    // so playback is not a decode away.
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 0.5 })).toBe(192 * MB);
  });

  it('assumes a modest desktop when the browser will not say', () => {
    expect(audioCacheBudgetBytes({})).toBe(audioCacheBudgetBytes({ deviceMemoryGb: 4 }));
  });

  it('assumes less on a touch device when the browser will not say', () => {
    // Safari exposes no deviceMemory, so an iPad is the one machine we are blind
    // on. A four-year-old tablet is not a 4 GB desktop.
    expect(audioCacheBudgetBytes({ coarsePointer: true })).toBe(
      audioCacheBudgetBytes({ deviceMemoryGb: 2 }),
    );
  });

  it('ignores the pointer as soon as the machine states its RAM', () => {
    // A touchscreen laptop reporting 8 GB is a laptop.
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 8, coarsePointer: true })).toBe(
      audioCacheBudgetBytes({ deviceMemoryGb: 8 }),
    );
  });

  it('lets a bridled JS heap limit lower the budget', () => {
    // A quarter of a 1.5 GB heap is less than a fifth of 4 GB of RAM: the
    // tighter of the two wins.
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 4, jsHeapSizeLimitBytes: 1.5 * GB })).toBe(
      Math.round(0.375 * GB),
    );
  });

  it('never lets the heap limit raise the budget, only cap it', () => {
    // Chrome routinely reports ~4 GB here, which must not overrule a machine
    // that only has 2 GB of RAM.
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 2, jsHeapSizeLimitBytes: 4 * GB })).toBe(
      audioCacheBudgetBytes({ deviceMemoryGb: 2 }),
    );
  });

  it('keeps the floor even under an absurdly small heap limit', () => {
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 4, jsHeapSizeLimitBytes: 256 * MB })).toBe(
      192 * MB,
    );
  });

  it('ignores a heap limit the browser reports as nonsense', () => {
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 4, jsHeapSizeLimitBytes: 0 })).toBe(
      audioCacheBudgetBytes({ deviceMemoryGb: 4 }),
    );
    expect(audioCacheBudgetBytes({ deviceMemoryGb: 4, jsHeapSizeLimitBytes: Infinity })).toBe(
      audioCacheBudgetBytes({ deviceMemoryGb: 4 }),
    );
  });
});

describe('trackDecodeCapBytes', () => {
  const cap = trackDecodeCapBytes(audioCacheBudgetBytes({ deviceMemoryGb: 4 }));

  it('is half the budget', () => {
    expect(cap).toBe(Math.round(audioCacheBudgetBytes({ deviceMemoryGb: 4 }) / 2));
  });

  it('leaves the short-form material this targets alone', () => {
    // Ten minutes of stereo, which is already long for the format.
    expect(decodedTrackBytes(10 * MINUTE, stereo)).toBeLessThanOrEqual(cap);
  });

  it('sits just under 19 minutes of stereo, and catches what is past it', () => {
    // The two sides of the same threshold: the guard has to be invisible below
    // it and present above, and this pins where "above" starts.
    expect(decodedTrackBytes(18 * MINUTE, stereo)).toBeLessThanOrEqual(cap);
    expect(decodedTrackBytes(19 * MINUTE, stereo)).toBeGreaterThan(cap);
  });

  it('catches the case it exists for: an hour-long source', () => {
    expect(decodedTrackBytes(60 * MINUTE, stereo)).toBeGreaterThan(cap);
  });

  it('is tighter on a handheld we could not measure', () => {
    const handheld = trackDecodeCapBytes(audioCacheBudgetBytes({ coarsePointer: true }));
    expect(handheld).toBeLessThan(cap);
    expect(decodedTrackBytes(5 * MINUTE, stereo)).toBeLessThanOrEqual(handheld);
  });
});

describe('isAllocationFailure', () => {
  it('recognizes what each engine actually throws', () => {
    // There is no error type for this, so the phrases are the interface.
    expect(isAllocationFailure(new RangeError('Array buffer allocation failed'))).toBe(true);
    expect(isAllocationFailure(new RangeError('Out of memory'))).toBe(true);
    expect(isAllocationFailure(new Error('Invalid array buffer length'))).toBe(true);
    expect(isAllocationFailure(new RangeError('Invalid array length'))).toBe(true);
    expect(isAllocationFailure('out of memory')).toBe(true);
  });

  it('does not claim unrelated failures', () => {
    // Misreading a decode error as an allocation failure would spend a pointless
    // retry and blame the machine for a broken file.
    expect(isAllocationFailure(new Error('Unsupported codec'))).toBe(false);
    expect(isAllocationFailure(new RangeError('sampleRate must be positive'))).toBe(false);
    expect(isAllocationFailure(undefined)).toBe(false);
    expect(isAllocationFailure({ message: 'out of memory' })).toBe(false);
  });
});

describe('AudioMemoryError', () => {
  it('carries what a message needs to name the cause', () => {
    const err = new AudioMemoryError('interview.mkv', 1, 1.1e9);
    expect(err.assetName).toBe('interview.mkv');
    expect(err.trackIndex).toBe(1);
    expect(err.estimatedBytes).toBe(1.1e9);
    expect(err.name).toBe('AudioMemoryError');
    // The console line has to be usable on its own too.
    expect(err.message).toContain('interview.mkv');
  });

  it('is distinguishable from every other decode failure', () => {
    // The retry-then-report path keys on exactly this.
    expect(new AudioMemoryError('a.mp3', undefined, 1) instanceof AudioMemoryError).toBe(true);
    expect(new Error('boom') instanceof AudioMemoryError).toBe(false);
  });
});
