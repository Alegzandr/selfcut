import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_CURSORS,
  MIN_LIVE_CURSORS,
  cursorBudgetBytes,
  frameBytes,
  maxLiveCursors,
  selectCursorEvictions,
} from './cursorPool';

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

describe('cursorBudgetBytes', () => {
  it('scales with the memory the device reports', () => {
    expect(cursorBudgetBytes(8)).toBeGreaterThan(cursorBudgetBytes(2));
  });

  it('assumes a mid-range machine when the browser will not say', () => {
    // Firefox and Safari do not expose deviceMemory. Assuming the worst would
    // cripple them; assuming the best would let them run out of memory.
    expect(cursorBudgetBytes(undefined)).toBe(cursorBudgetBytes(4));
  });

  it('never goes below a floor a 4K crossfade can still use', () => {
    expect(cursorBudgetBytes(0.25)).toBeGreaterThanOrEqual(96 * 1024 * 1024);
  });

  it('never grows past a ceiling, however much RAM is reported', () => {
    expect(cursorBudgetBytes(1024)).toBeLessThanOrEqual(768 * 1024 * 1024);
  });
});

describe('frameBytes', () => {
  it('sizes a 4K 4:2:0 frame at about 12 MB', () => {
    expect(frameBytes(3840, 2160) / (1024 * 1024)).toBeCloseTo(11.9, 1);
  });

  it('sizes a 1080p frame at about 3 MB', () => {
    expect(frameBytes(1920, 1080) / (1024 * 1024)).toBeCloseTo(3, 1);
  });

  it('takes a larger per-pixel cost for deeper sources', () => {
    expect(frameBytes(1920, 1080, 3)).toBe(frameBytes(1920, 1080, 1.5) * 2);
  });
});

describe('maxLiveCursors', () => {
  it('holds fewer 4K cursors than HD ones on the same machine', () => {
    // The whole point: the old fixed count of 8 meant ~200 MB of 4K frames or
    // ~25 MB of 720p ones, and called both "eight".
    const uhd = maxLiveCursors(frameBytes(3840, 2160), 1);
    const hd = maxLiveCursors(frameBytes(1280, 720), 1);
    expect(uhd).toBeLessThan(hd);
  });

  it('holds more on a machine with more memory', () => {
    expect(maxLiveCursors(frameBytes(3840, 2160), 8)).toBeGreaterThanOrEqual(
      maxLiveCursors(frameBytes(3840, 2160), 1),
    );
  });

  it('never drops below what a crossfade on two stacked tracks needs', () => {
    // Four clips can be on screen at one instant. Evicting one of them would
    // dispose a decoder the very next frame asks for.
    expect(maxLiveCursors(frameBytes(7680, 4320), 0.25)).toBeGreaterThanOrEqual(MIN_LIVE_CURSORS);
  });

  it('never exceeds what a browser will decode in parallel', () => {
    expect(maxLiveCursors(frameBytes(320, 240), 8)).toBeLessThanOrEqual(MAX_LIVE_CURSORS);
  });

  it('survives a nonsense frame size without returning Infinity', () => {
    expect(maxLiveCursors(0, 4)).toBe(MAX_LIVE_CURSORS);
  });
});
