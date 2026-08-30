import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { Keyframe, MediaAsset } from '../types';
import { sampleChannel } from '../model/animation';

/**
 * Splitting a clip razors its animation too: each half keeps only the stretch of
 * keyframes it covers, rebased to its own start, and neither half jumps at the
 * cut. Before this, both halves carried a copy of the whole animation and each
 * replayed the full move in its own, shorter span.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, durationMs = 4000): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const clips = () => s().project.tracks.find((t) => t.kind === 'video')!.clips.slice().sort(
  (a, b) => a.timelineStartMs - b.timelineStartMs,
);
const keysOf = (i: number) => clips()[i]!.animation?.scale as Keyframe[];

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('a'));
  s().addClipFromAsset('a'); // one 4000 ms video clip at timeline 0
});

describe('splitAtPlayhead with keyframes', () => {
  beforeEach(() => {
    const id = clips()[0]!.id;
    s().toggleClipKeyframe(id, 'scale', 0);
    s().updateClipTransformLive(id, { scale: 1 }, 0);
    s().updateClipTransformLive(id, { scale: 3 }, 4000);
    s().seek(2000);
    s().splitAtPlayhead();
  });

  it('gives each half only its own keyframes, rebased to its start', () => {
    expect(clips()).toHaveLength(2);
    expect(keysOf(0)).toEqual([
      { t: 0, value: 1 },
      { t: 2000, value: 2 },
    ]);
    expect(keysOf(1)).toEqual([
      { t: 0, value: 2 },
      { t: 2000, value: 3 },
    ]);
  });

  it('animates continuously across the cut', () => {
    const [left, right] = clips();
    // The value at the cut is the same frame on both sides: no jump.
    expect(sampleChannel(left!.animation!.scale!, 2000)).toBeCloseTo(
      sampleChannel(right!.animation!.scale!, 0),
      5,
    );
    // And the ends of the original move survive untouched.
    expect(sampleChannel(left!.animation!.scale!, 0)).toBe(1);
    expect(sampleChannel(right!.animation!.scale!, 2000)).toBe(3);
  });
});

describe('splitAtPlayhead with colour and mask keyframes', () => {
  it('razors colour channels and mask motion like transform props', () => {
    const id = clips()[0]!.id;
    s().updateClip(id, {
      color: { brightness: [{ t: 0, value: 0, ease: 'linear' }, { t: 4000, value: 1 }] },
      mask: {
        shape: 'rect',
        x: 0.5,
        y: 0.5,
        w: 0.5,
        h: 0.5,
        feather: 0,
        motion: { tx: [{ t: 0, value: 0, ease: 'linear' }, { t: 4000, value: 0.4 }] },
      },
    });
    s().seek(2000);
    s().splitAtPlayhead();
    const [left, right] = clips();
    expect(left!.color!.brightness).toEqual([
      { t: 0, value: 0, ease: 'linear' },
      { t: 2000, value: 0.5, ease: 'linear' },
    ]);
    expect(right!.color!.brightness).toEqual([
      { t: 0, value: 0.5, ease: 'linear' },
      { t: 2000, value: 1 },
    ]);
    expect(sampleChannel(right!.mask!.motion!.tx!, 2000)).toBeCloseTo(0.4, 5);
    expect(sampleChannel(left!.mask!.motion!.tx!, 0)).toBeCloseTo(0, 5);
  });
});

describe('trimClip left with keyframes', () => {
  it('keeps keyframes on the frames they were authored on', () => {
    const id = clips()[0]!.id;
    s().toggleClipKeyframe(id, 'scale', 0);
    s().updateClipTransformLive(id, { scale: 1 }, 0);
    s().updateClipTransformLive(id, { scale: 3 }, 2000);
    s().trimClip(id, 'left', 1000);
    // The key authored on the frame at timeline 2000 still sits there.
    const c = clips()[0]!;
    expect(c.timelineStartMs).toBe(1000);
    expect(sampleChannel(c.animation!.scale!, 2000 - c.timelineStartMs)).toBeCloseTo(3, 5);
  });
});
