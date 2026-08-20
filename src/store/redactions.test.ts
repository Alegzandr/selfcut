import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { defaultRedaction } from '../model';

/**
 * Redaction regions on a clip. A list, not a single field, so the edits that
 * matter are the ones that have to hit exactly one entry and leave its
 * neighbours alone — and the removal that has to leave `undefined` rather than
 * an empty array, since an empty array would still send every frame of the clip
 * through the redaction scratch.
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
const regions = () => clip().redactions ?? [];

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('a'));
  s().addClipFromAsset('a');
});

describe('addClipRedaction', () => {
  it('appends regions in the order they were added, each with its own id', () => {
    const first = s().addClipRedaction(clip().id, defaultRedaction());
    const second = s().addClipRedaction(clip().id, { ...defaultRedaction(), mode: 'pixelate' });
    expect(regions().map((r) => r.id)).toEqual([first, second]);
    expect(regions()[1]!.mode).toBe('pixelate');
    expect(first).not.toBe(second);
  });

  it('is one undo step', () => {
    s().addClipRedaction(clip().id, defaultRedaction());
    s().undo();
    expect(regions()).toHaveLength(0);
  });
});

describe('setClipRedaction', () => {
  it('patches only the named region', () => {
    const first = s().addClipRedaction(clip().id, defaultRedaction());
    const second = s().addClipRedaction(clip().id, defaultRedaction());
    s().setClipRedaction(clip().id, second, { amount: 0.1, mode: 'pixelate' });
    expect(regions().find((r) => r.id === first)!.amount).toBe(defaultRedaction().amount);
    const edited = regions().find((r) => r.id === second)!;
    expect(edited.amount).toBe(0.1);
    expect(edited.mode).toBe('pixelate');
    // Untouched fields survive the patch: the pen writes a shape without
    // knowing anything about the strength that was already dialled in.
    expect(edited.feather).toBe(defaultRedaction().feather);
  });

  it('ignores an id that is not on the clip', () => {
    s().addClipRedaction(clip().id, defaultRedaction());
    const before = regions();
    s().setClipRedaction(clip().id, 'nope', { amount: 0.1 });
    expect(regions()).toEqual(before);
  });
});

describe('removeClipRedaction', () => {
  it('drops the list entirely once the last region goes', () => {
    const only = s().addClipRedaction(clip().id, defaultRedaction());
    s().removeClipRedaction(clip().id, only);
    expect(clip().redactions).toBeUndefined();
  });

  it('keeps the others, and lets go of the one being edited', () => {
    const first = s().addClipRedaction(clip().id, defaultRedaction());
    const second = s().addClipRedaction(clip().id, defaultRedaction());
    s().setSelectedRedactionId(second);
    s().removeClipRedaction(clip().id, second);
    expect(regions().map((r) => r.id)).toEqual([first]);
    expect(s().selectedRedactionId).toBeNull();
  });
});

describe('redaction motion', () => {
  it('writes a constant until the axis is keyframed, then writes keys', () => {
    const id = s().addClipRedaction(clip().id, defaultRedaction());
    s().setClipRedactionMotionLive(clip().id, id, 'tx', 0.2, 1000);
    expect(regions()[0]!.motion?.tx).toBe(0.2);

    s().toggleClipRedactionMotionKeyframe(clip().id, id, 'tx', 1000);
    const keys = regions()[0]!.motion?.tx;
    expect(Array.isArray(keys)).toBe(true);
    // The key holds what the constant held, so turning animation on never makes
    // the region jump.
    expect((keys as { t: number; value: number }[])[0]).toMatchObject({ t: 1000, value: 0.2 });

    s().setClipRedactionMotionLive(clip().id, id, 'tx', 0.4, 2000);
    const grown = regions()[0]!.motion!.tx as { t: number }[];
    expect(grown.map((k) => k.t)).toEqual([1000, 2000]);
  });

  it('collapses back to a constant when the last key is toggled off', () => {
    const id = s().addClipRedaction(clip().id, defaultRedaction());
    s().toggleClipRedactionMotionKeyframe(clip().id, id, 'scale', 500);
    expect(Array.isArray(regions()[0]!.motion?.scale)).toBe(true);
    s().toggleClipRedactionMotionKeyframe(clip().id, id, 'scale', 500);
    // The identity the key was holding, not an empty channel: an empty array
    // would sample as 0 and collapse the region to nothing.
    expect(regions()[0]!.motion?.scale).toBe(1);
  });

  it('leaves a region alone when the playhead is outside its clip', () => {
    const id = s().addClipRedaction(clip().id, defaultRedaction());
    s().setClipRedactionMotionLive(clip().id, id, 'tx', 0.2, 1000);
    s().toggleClipRedactionMotionKeyframe(clip().id, id, 'tx', 1000);
    const before = regions()[0]!.motion?.tx;
    s().setClipRedactionMotionLive(clip().id, id, 'tx', 0.9, 999_000);
    expect(regions()[0]!.motion?.tx).toEqual(before);
  });
});
