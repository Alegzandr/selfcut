import { describe, expect, it, beforeAll } from 'vitest';
import type { CacheMeta } from './audioCache';

/**
 * The eviction policy alone - which entries go, in what order. The module
 * reaches the store (to know what is on the timeline) and so drags in the DOM
 * on import; stubbed and dynamically imported like undecodableAudio.test.ts.
 */
let selectEvictions: typeof import('./audioCache').selectEvictions;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ selectEvictions } = await import('./audioCache'));
});

const MB = 1024 * 1024;

function entry(mediaKey: string, lastUsedAt: number, mb = 100): [string, CacheMeta] {
  return [`${mediaKey}#0`, { mediaKey, trackIndex: 0, byteLength: mb * MB, lastUsedAt }];
}

const nothingPinned = new Set<string>();

describe('selectEvictions', () => {
  it('keeps everything while the cache fits', () => {
    const entries = [entry('a', 1), entry('b', 2)];
    expect(selectEvictions(entries, 500 * MB, nothingPinned)).toEqual([]);
  });

  it('drops the least recently used first, and stops as soon as it fits', () => {
    const entries = [entry('recent', 300), entry('oldest', 100), entry('middle', 200)];
    // 300 MB held, 250 MB allowed: one eviction is enough.
    expect(selectEvictions(entries, 250 * MB, nothingPinned)).toEqual(['oldest#0']);
  });

  it('evicts as many as the target demands', () => {
    const entries = [entry('a', 100), entry('b', 200), entry('c', 300)];
    expect(selectEvictions(entries, 100 * MB, nothingPinned)).toEqual(['a#0', 'b#0']);
  });

  // The point of the pinned tier: footage on the timeline is re-decoded the
  // moment the project reopens, so evicting it is the one case the user would
  // actually feel.
  it('sacrifices library-only footage before anything on the timeline', () => {
    const entries = [entry('onTimeline', 1), entry('libraryOnly', 999)];
    const pinned = new Set(['onTimeline']);
    expect(selectEvictions(entries, 100 * MB, pinned)).toEqual(['libraryOnly#0']);
  });

  it('falls through to pinned entries when unpinned ones are not enough', () => {
    const entries = [entry('pinnedOld', 100), entry('pinnedNew', 300), entry('loose', 200)];
    const pinned = new Set(['pinnedOld', 'pinnedNew']);
    // 300 MB held, 100 MB allowed: dropping the only loose entry leaves 200 MB,
    // so the oldest pinned one has to go too.
    expect(selectEvictions(entries, 100 * MB, pinned)).toEqual(['loose#0', 'pinnedOld#0']);
  });

  // Evicting the entry a save is making room for would make the save pointless,
  // and on the quota-retry path it is the very thing being written.
  it('never evicts the entry being written', () => {
    const entries = [entry('incoming', 1), entry('other', 999)];
    expect(selectEvictions(entries, 100 * MB, nothingPinned, 'incoming#0')).toEqual(['other#0']);
  });

  it('gives up rather than looping when the kept entry alone overflows', () => {
    const entries = [entry('incoming', 1, 500)];
    expect(selectEvictions(entries, 100 * MB, nothingPinned, 'incoming#0')).toEqual([]);
  });
});
