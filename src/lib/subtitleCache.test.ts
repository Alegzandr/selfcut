import { describe, expect, it } from 'vitest';
import { selectEvictions, type SubtitleCacheMeta } from './subtitleCache';

/**
 * The entry-count policy alone. Unlike the audio cache's, this module reaches
 * no store, so it imports plainly.
 */
function entry(mediaKey: string, lastUsedAt: number): [string, SubtitleCacheMeta] {
  return [`${mediaKey}#s0`, { mediaKey, trackIndex: 0, lastUsedAt }];
}

describe('selectEvictions', () => {
  it('keeps everything while the cache fits', () => {
    expect(selectEvictions([entry('a', 1), entry('b', 2)], 5)).toEqual([]);
  });

  it('drops the least recently used first, and only down to the cap', () => {
    const entries = [entry('recent', 300), entry('oldest', 100), entry('middle', 200)];
    expect(selectEvictions(entries, 2)).toEqual(['oldest#s0']);
  });

  // The incoming entry occupies a slot it cannot be evicted for: counting it
  // out would let the store settle one entry above the cap for ever.
  it('counts the entry about to be written against the cap', () => {
    const entries = [entry('a', 100), entry('b', 200)];
    expect(selectEvictions(entries, 2, 'c#s0')).toEqual(['a#s0']);
  });

  it('leaves room untouched when the incoming entry overwrites an existing one', () => {
    const entries = [entry('a', 100), entry('b', 200)];
    expect(selectEvictions(entries, 2, 'a#s0')).toEqual([]);
  });

  it('never evicts the entry being written', () => {
    const entries = [entry('incoming', 1), entry('other', 999)];
    expect(selectEvictions(entries, 1, 'incoming#s0')).toEqual(['other#s0']);
  });
});
