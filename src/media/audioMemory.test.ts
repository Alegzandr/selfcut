import { describe, expect, it } from 'vitest';
import {
  AudioMemoryError,
  audioCacheBudgetBytes,
  isAllocationFailure,
} from './audioMemory';
import { SEGMENT_MS } from './audioSegments';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Bytes one 48 kHz stereo segment occupies once decoded. */
const SEGMENT_BYTES = (SEGMENT_MS / 1000) * 48_000 * 2 * 4;

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

describe('the budget against the segment grid', () => {
  it('holds several minutes of decoded audio even on the machine it trusts least', () => {
    // The floor is what a browser that under-reports gets, and it still has to
    // cover the window the preview keeps around the playhead (scheduling
    // horizon + prefetch, on more than one track at once) with room to spare.
    const segments = audioCacheBudgetBytes({ coarsePointer: true }) / SEGMENT_BYTES;
    expect(segments).toBeGreaterThan(8);
  });

  it('never lets one segment be the allocation that fails', () => {
    // The case that used to kill the tab was a single object too large to fit.
    // A segment is a fixed 30 s whatever the source's length, so the ratio
    // below is what makes an hour-long recording no different from a short one.
    expect(SEGMENT_BYTES).toBeLessThan(audioCacheBudgetBytes({ coarsePointer: true }) / 8);
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
