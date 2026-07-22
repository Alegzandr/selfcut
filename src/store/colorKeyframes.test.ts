import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { Keyframe, MediaAsset } from '../types';

/**
 * Keyframing a colour parameter. Unlike a transform prop, a colour param has no
 * separate static field: its `Channel` is the number until it becomes an array
 * and back again, which is the asymmetry `writeChannel` exists to hide.
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
const contrast = () => clip().color?.contrast;

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('a'));
  s().addClipFromAsset('a');
});

describe('updateClipColorLive', () => {
  it('writes a constant while the parameter is not animated', () => {
    s().updateClipColorLive(clip().id, 'contrast', 0.4, 1000);
    expect(contrast()).toBe(0.4);
  });

  it('writes the keyframe under the playhead once it animates', () => {
    s().toggleClipKeyframe(clip().id, 'contrast', 1000);
    s().updateClipColorLive(clip().id, 'contrast', 0.6, 1000);
    expect(contrast()).toEqual([{ t: 1000, value: 0.6 }]);
    // A drag at another time adds a key there rather than moving the first.
    s().updateClipColorLive(clip().id, 'contrast', 0.2, 3000);
    expect(contrast()).toEqual([
      { t: 1000, value: 0.6 },
      { t: 3000, value: 0.2 },
    ]);
  });
});

describe('toggleClipKeyframe on a colour parameter', () => {
  it('seeds the first key from the constant the parameter already showed', () => {
    s().updateClipColorLive(clip().id, 'saturation', 0.35, 0);
    s().toggleClipKeyframe(clip().id, 'saturation', 2000);
    expect(clip().color?.saturation).toEqual([{ t: 2000, value: 0.35 }]);
  });

  it('collapses back to the value it held when the last key goes', () => {
    s().updateClipColorLive(clip().id, 'contrast', 0.5, 0);
    s().toggleClipKeyframe(clip().id, 'contrast', 0); // animate, seeded at 0.5
    s().updateClipColorLive(clip().id, 'contrast', 0.8, 0);
    s().toggleClipKeyframe(clip().id, 'contrast', 0); // de-animate
    expect(contrast()).toBe(0.8);
  });

  it('keeps the other keys when one of several is removed', () => {
    const id = clip().id;
    s().toggleClipKeyframe(id, 'blur', 0);
    s().updateClipColorLive(id, 'blur', 0.3, 2000);
    expect(clip().color?.blur).toHaveLength(2);
    s().toggleClipKeyframe(id, 'blur', 2000);
    // One key left is still an animated property, not a collapse.
    expect(clip().color?.blur).toEqual([{ t: 0, value: 0 }]);
  });

  it('does not touch the transform, which colour keys have no business in', () => {
    s().toggleClipKeyframe(clip().id, 'vignette', 0);
    expect(clip().animation).toBeUndefined();
    expect(clip().transform).toBeUndefined();
  });
});

describe('setClipKeyframesEase', () => {
  it('re-eases a colour key and a transform key sharing the playhead', () => {
    const id = clip().id;
    s().toggleClipKeyframe(id, 'scale', 1000);
    s().toggleClipKeyframe(id, 'contrast', 1000);
    s().setClipKeyframesEase(id, 1000, 'hold');
    expect(clip().animation?.scale?.[0]?.ease).toBe('hold');
    expect((contrast() as Keyframe[])[0]?.ease).toBe('hold');
  });
});
