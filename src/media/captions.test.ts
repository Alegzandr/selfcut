import { describe, expect, it } from 'vitest';
import { segmentsToCues } from './captions';
import type { CaptionSegment } from './captionsProtocol';
import type { MediaClip } from '../types';

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    kind: 'media',
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 1000,
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  };
}

const seg = (startSec: number, endSec: number | null, text: string): CaptionSegment => ({ startSec, endSec, text });

describe('segmentsToCues', () => {
  it('offsets segment times by the clip start on the timeline', () => {
    const cues = segmentsToCues([seg(0, 1, 'hello'), seg(1, 2, 'world')], clip());
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'hello' },
      { startMs: 2000, endMs: 3000, text: 'world' },
    ]);
  });

  it('compresses times by the clip speed', () => {
    // speed 2 → the clip is 2500 ms long on the timeline (source 5000 / 2).
    const cues = segmentsToCues([seg(1, 2, 'x')], clip({ speed: 2 }));
    expect(cues[0]!.startMs).toBe(1000 + 500);
    expect(cues[0]!.endMs).toBe(1000 + 1000);
  });

  it('borrows the next start when a segment has no end', () => {
    const cues = segmentsToCues([seg(0, null, 'a'), seg(1.5, 2, 'b')], clip());
    expect(cues[0]!.endMs).toBe(1000 + 1500);
  });

  it('clamps to the clip end and drops segments beyond it', () => {
    // Clip ends at 1000 + 5000 = 6000 ms.
    const cues = segmentsToCues([seg(4.5, 10, 'tail'), seg(6, 7, 'gone')], clip());
    expect(cues).toHaveLength(1);
    expect(cues[0]!.endMs).toBe(6000);
  });
});
