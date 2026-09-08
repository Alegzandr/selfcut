import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { defaultLocalAdjust, defaultRedaction } from '../model';

/**
 * Local adjustment regions on a clip.
 *
 * The list edits are the redactions' (one entry hit, its neighbours left alone,
 * a removal that leaves `undefined` rather than an empty array). What is new
 * here is the grade a region carries, and the rule every keyframable control in
 * this editor follows: once a parameter animates, dragging it writes the key
 * under the playhead instead of a constant that would wipe the animation.
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
const regions = () => clip().localAdjusts ?? [];

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('a'));
  s().addClipFromAsset('a');
});

describe('addClipLocalAdjust', () => {
  it('appends regions in the order they were added, each with its own id', () => {
    const first = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    const second = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    expect(regions().map((r) => r.id)).toEqual([first, second]);
    expect(first).not.toBe(second);
  });

  it('starts with no grade at all, so the region changes nothing until asked', () => {
    s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    expect(regions()[0]!.color).toEqual({});
  });

  it('is one undo step', () => {
    s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().undo();
    expect(regions()).toHaveLength(0);
  });
});

describe('removeClipLocalAdjust', () => {
  it('drops the list entirely on the last removal, never leaving an empty array', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().removeClipLocalAdjust(clip().id, id);
    expect(clip().localAdjusts).toBeUndefined();
  });

  it('clears the selection when the open region is the one removed', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().setSelectedLocalAdjustId(id);
    s().removeClipLocalAdjust(clip().id, id);
    expect(s().selectedLocalAdjustId).toBeNull();
  });
});

describe('setClipLocalAdjustColorLive', () => {
  it('writes a constant while the parameter does not animate', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().setClipLocalAdjustColorLive(clip().id, id, 'brightness', 0.4, 0);
    expect(regions()[0]!.color.brightness).toBe(0.4);
  });

  it('leaves the other regions alone', () => {
    const first = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().setClipLocalAdjustColorLive(clip().id, first, 'contrast', 0.5, 0);
    expect(regions()[1]!.color.contrast).toBeUndefined();
  });

  it('writes the keyframe under the playhead once the parameter animates', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().setClipLocalAdjustColorLive(clip().id, id, 'brightness', 0.2, 0);
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'brightness', 0);
    s().setClipLocalAdjustColorLive(clip().id, id, 'brightness', 0.9, 2000);
    const ch = regions()[0]!.color.brightness;
    expect(ch).toEqual([
      { t: 0, value: 0.2 },
      { t: 2000, value: 0.9 },
    ]);
  });
});

describe('toggleClipLocalAdjustColorKeyframe', () => {
  it('seeds the first key at the value the region currently shows', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().setClipLocalAdjustColorLive(clip().id, id, 'saturation', -0.3, 0);
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'saturation', 1000);
    expect(regions()[0]!.color.saturation).toEqual([{ t: 1000, value: -0.3 }]);
  });

  it('removes the key sitting on the playhead and adds one anywhere else', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'tint', 0);
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'tint', 1000);
    expect(regions()[0]!.color.tint).toHaveLength(2);
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'tint', 1000);
    expect(regions()[0]!.color.tint).toEqual([{ t: 0, value: 0 }]);
  });

  it('does nothing when the playhead is outside the clip', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'brightness', 99_000);
    expect(regions()[0]!.color.brightness).toBeUndefined();
  });
});

describe('the open shape', () => {
  it('is one at a time: opening a region closes any open redaction, and back', () => {
    const adjust = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    const redaction = s().addClipRedaction(clip().id, defaultRedaction());

    s().setSelectedLocalAdjustId(adjust);
    s().setSelectedRedactionId(redaction);
    expect(s().selectedLocalAdjustId).toBeNull();

    s().setSelectedLocalAdjustId(adjust);
    expect(s().selectedRedactionId).toBeNull();
  });
});

describe('splitting a clip', () => {
  it('gives both halves the region, each animating only the stretch it covers', () => {
    const id = s().addClipLocalAdjust(clip().id, defaultLocalAdjust());
    // Animate it, then drag at 4000: the second key comes from the drag itself.
    s().toggleClipLocalAdjustColorKeyframe(clip().id, id, 'brightness', 0);
    s().setClipLocalAdjustColorLive(clip().id, id, 'brightness', 1, 4000);

    s().seek(2000);
    s().splitAtPlayhead();

    const clips = s().project.tracks.find((t) => t.kind === 'video')!.clips;
    expect(clips).toHaveLength(2);
    const [left, right] = clips as [(typeof clips)[number], (typeof clips)[number]];
    // Clip-local times, rebased per half: the right one's keys start at 0 again.
    const leftKeys = left.localAdjusts![0]!.color.brightness;
    const rightKeys = right.localAdjusts![0]!.color.brightness;
    expect(Array.isArray(leftKeys) && leftKeys[0]!.t).toBe(0);
    expect(Array.isArray(rightKeys) && rightKeys[rightKeys.length - 1]!.t).toBe(2000);
  });
});
