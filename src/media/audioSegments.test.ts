import { describe, expect, it } from 'vitest';
import {
  SEGMENT_MS,
  segmentCount,
  segmentIndexAt,
  segmentIndexes,
  segmentStartMs,
} from './audioSegments';

/**
 * The grid decides which decoded piece answers a time range, so it is what
 * makes a cache hit a cache hit. Two properties matter beyond the arithmetic:
 * a range must never be covered by a gap (silence in the middle of a clip),
 * and a range that moves without leaving its pieces must not change the answer
 * (a trim handle dragged by a frame must not re-decode 30 s).
 */
describe('the segment grid', () => {
  it('maps a timestamp to the piece containing it', () => {
    expect(segmentIndexAt(0)).toBe(0);
    expect(segmentIndexAt(SEGMENT_MS - 1)).toBe(0);
    expect(segmentIndexAt(SEGMENT_MS)).toBe(1);
    expect(segmentIndexAt(2.5 * SEGMENT_MS)).toBe(2);
  });

  it('treats a negative timestamp as the start of the source', () => {
    // Nothing produces one deliberately, but a clip whose in point is nudged
    // past zero by a rounding error must not address segment -1.
    expect(segmentIndexAt(-1)).toBe(0);
    expect(segmentIndexAt(-SEGMENT_MS * 3)).toBe(0);
  });

  it('reports where a piece begins, which is what a buffer is anchored to', () => {
    expect(segmentStartMs(0)).toBe(0);
    expect(segmentStartMs(4)).toBe(4 * SEGMENT_MS);
  });

  describe('covering a range', () => {
    it('returns every piece the range touches, in order', () => {
      expect(segmentIndexes(0, SEGMENT_MS)).toEqual([0]);
      expect(segmentIndexes(0, SEGMENT_MS + 1)).toEqual([0, 1]);
      expect(segmentIndexes(SEGMENT_MS * 2 - 1, SEGMENT_MS * 4)).toEqual([1, 2, 3]);
    });

    it('leaves no gap: consecutive ranges join at the same piece', () => {
      // The property that matters for playback. A range ending exactly on a
      // boundary must not claim the next piece, and the range starting there
      // must claim it - otherwise the audio has a hole 30 s wide.
      const first = segmentIndexes(0, SEGMENT_MS);
      const second = segmentIndexes(SEGMENT_MS, 2 * SEGMENT_MS);
      expect(first).toEqual([0]);
      expect(second).toEqual([1]);
    });

    it('covers nothing for an empty or inverted range', () => {
      // A clip trimmed to nothing asks for no audio; answering with a piece
      // would decode 30 s for a request for none.
      expect(segmentIndexes(1000, 1000)).toEqual([]);
      expect(segmentIndexes(5000, 1000)).toEqual([]);
    });

    it('is unchanged by a small move inside the same pieces', () => {
      // What makes trimming cheap: a handle dragged a frame either way lands
      // on the same decoded audio.
      const base = segmentIndexes(SEGMENT_MS + 1000, SEGMENT_MS + 5000);
      expect(segmentIndexes(SEGMENT_MS + 1040, SEGMENT_MS + 5040)).toEqual(base);
    });

    it('counts what it would return, without building it', () => {
      for (const [from, to] of [
        [0, SEGMENT_MS],
        [0, SEGMENT_MS * 3.5],
        [SEGMENT_MS * 1.5, SEGMENT_MS * 1.6],
        [10, 10],
      ]) {
        expect(segmentCount(from!, to!)).toBe(segmentIndexes(from!, to!).length);
      }
    });
  });

  it('keeps an hour-long source to a bounded number of pieces of bounded size', () => {
    // The whole point: the old decode was one 1.4 GB allocation for this
    // source. Every piece is the same size whatever the source's length, so
    // what is held is a function of the window played, not of the file.
    const hour = 60 * 60_000;
    expect(segmentCount(0, hour)).toBe(hour / SEGMENT_MS);
    const stereoSegmentBytes = (SEGMENT_MS / 1000) * 48_000 * 2 * 4;
    expect(stereoSegmentBytes).toBeLessThan(16 * 1024 * 1024);
  });
});
