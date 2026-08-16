import { describe, expect, it } from 'vitest';
import { MAX_LIVE_CURSORS, selectCursorEvictions } from './cursorPool';

const keep = (...ids: string[]) => new Set(ids);

describe('selectCursorEvictions', () => {
  it('keeps everything while under the cap', () => {
    expect(selectCursorEvictions(['a', 'b', 'c'], keep('c'), 4)).toEqual([]);
    expect(selectCursorEvictions(['a', 'b', 'c', 'd'], keep('d'), 4)).toEqual([]);
  });

  it('drops the least recently used first, and only the overflow', () => {
    // Order is oldest-first, so 'a' has not been drawn for the longest.
    expect(selectCursorEvictions(['a', 'b', 'c', 'd', 'e'], keep('e'), 3)).toEqual(['a', 'b']);
  });

  it('never releases a cursor drawn in the current frame', () => {
    // 'a' and 'b' are the oldest but are both on screen right now (stacked
    // tracks, or a crossfade): the overflow has to come from behind them.
    expect(selectCursorEvictions(['a', 'b', 'c', 'd'], keep('a', 'b'), 2)).toEqual(['c', 'd']);
  });

  it('gives up rather than evicting a visible cursor', () => {
    // More clips visible at one instant than the cap allows: every one of them
    // is about to be asked for a frame, so releasing any is strictly worse than
    // running over. The pool is a ceiling on idle decoders, not on live ones.
    expect(selectCursorEvictions(['a', 'b', 'c'], keep('a', 'b', 'c'), 1)).toEqual([]);
  });

  it('walks a long scrub back down to the cap in one pass', () => {
    // What a pass over a many-clip timeline used to leave behind: one live
    // decoder per clip the playhead ever crossed.
    const ids = Array.from({ length: 40 }, (_, i) => `clip-${i}`);
    const doomed = selectCursorEvictions(ids, keep('clip-39'));
    expect(ids.length - doomed.length).toBe(MAX_LIVE_CURSORS);
    expect(doomed).not.toContain('clip-39');
    // Oldest first: the clips at the head of the timeline go before the ones
    // just behind the playhead.
    expect(doomed[0]).toBe('clip-0');
  });
});
