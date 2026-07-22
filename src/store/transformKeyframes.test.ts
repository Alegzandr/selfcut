import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { Keyframe, MediaAsset } from '../types';

/**
 * The keyframe write path: the inspector diamond (toggleClipKeyframe) and the
 * keyframe-aware live transform edit shared by the inspector sliders and the
 * preview gestures (updateClipTransformLive). Store bootstrapped like the other
 * store tests: node environment, document stubbed.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, durationMs = 5000): MediaAsset {
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
const clip = () => s().project.tracks.find((t) => t.kind === 'video')!.clips[0]!;
const scaleKeys = () => clip().animation?.scale as Keyframe[] | undefined;

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('a'));
  s().addClipFromAsset('a'); // one video clip starting at timeline 0
});

describe('updateClipTransformLive', () => {
  it('edits the static transform when the property is not animated', () => {
    s().updateClipTransformLive(clip().id, { x: 0.3 }, 1000);
    expect(clip().transform?.x).toBe(0.3);
    expect(clip().animation).toBeUndefined();
  });

  it('writes a keyframe instead of the static value once the property animates', () => {
    s().seek(1000);
    s().toggleClipKeyframe(clip().id, 'scale', 1000); // enable, seeds value 1 at local 1000
    s().updateClipTransformLive(clip().id, { scale: 2 }, 1000); // updates the key on the playhead
    expect(scaleKeys()).toEqual([{ t: 1000, value: 2 }]);
    // Editing at a new time adds a keyframe there rather than moving the first.
    s().updateClipTransformLive(clip().id, { scale: 3 }, 3000);
    expect(scaleKeys()).toEqual([
      { t: 1000, value: 2 },
      { t: 3000, value: 3 },
    ]);
  });
});

describe('toggleClipKeyframe', () => {
  it('enables animation by seeding one keyframe at the current value', () => {
    s().seek(1000);
    s().toggleClipKeyframe(clip().id, 'scale', 1000);
    expect(scaleKeys()).toEqual([{ t: 1000, value: 1 }]);
  });

  it('adds a keyframe at the playhead when none sits there', () => {
    s().toggleClipKeyframe(clip().id, 'scale', 0);
    s().updateClipTransformLive(clip().id, { scale: 4 }, 0);
    s().toggleClipKeyframe(clip().id, 'scale', 2000); // no key here yet -> add at sampled value
    const keys = scaleKeys()!;
    expect(keys.map((k) => k.t)).toEqual([0, 2000]);
    // A single-keyframe channel holds, so the added key captures value 4.
    expect(keys[1]!.value).toBe(4);
  });

  it('keeps the clip animated while more than one keyframe survives', () => {
    s().toggleClipKeyframe(clip().id, 'scale', 0);
    s().updateClipTransformLive(clip().id, { scale: 2 }, 2000);
    s().toggleClipKeyframe(clip().id, 'scale', 2000); // remove the key at 2000
    expect(scaleKeys()).toEqual([{ t: 0, value: 1 }]);
  });

  it('de-animates on the last keyframe and preserves its value in the static transform', () => {
    s().seek(1000);
    s().toggleClipKeyframe(clip().id, 'scale', 1000);
    s().updateClipTransformLive(clip().id, { scale: 2.5 }, 1000);
    s().toggleClipKeyframe(clip().id, 'scale', 1000); // remove the only key
    expect(clip().animation).toBeUndefined();
    expect(clip().transform?.scale).toBe(2.5);
  });

  it('is one undo step and can be reverted', () => {
    s().toggleClipKeyframe(clip().id, 'scale', 0);
    expect(scaleKeys()).toHaveLength(1);
    s().undo();
    expect(clip().animation?.scale).toBeUndefined();
  });
});
