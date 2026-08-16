import { describe, expect, it } from 'vitest';
import { audioCacheBudgetBytes, selectAudioEvictions } from './mediaCache';

type Entry = { bytes: number; lastUsedAt: number; pinned: boolean };

const entry = (bytes: number, lastUsedAt: number, pinned = false): Entry => ({
  bytes,
  lastUsedAt,
  pinned,
});

const MB = 1024 * 1024;

describe('audioCacheBudgetBytes', () => {
  it('scales with the machine, between a floor and a ceiling', () => {
    expect(audioCacheBudgetBytes(16)).toBe(1024 * MB);
    expect(audioCacheBudgetBytes(8)).toBe(1024 * MB);
    // Between the rails it is simply a fifth of what the machine reports.
    expect(audioCacheBudgetBytes(4)).toBe(Math.round(0.8 * 1024 * MB));
    // A machine that reports very little RAM still gets enough for a couple of
    // tracks: the cache exists precisely so playback is not a decode away.
    expect(audioCacheBudgetBytes(0.5)).toBe(192 * MB);
  });

  it('assumes a modest machine when the browser will not say', () => {
    // Safari and Firefox do not expose deviceMemory at all.
    expect(audioCacheBudgetBytes(undefined)).toBe(audioCacheBudgetBytes(4));
  });
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
    const budget = audioCacheBudgetBytes(8);
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
