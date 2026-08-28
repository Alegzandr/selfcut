import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { Keyframe, MediaAsset } from '../types';

/**
 * The easing write paths behind the graph editor and the keyframe context menu:
 * a named preset over the boxed selection, a custom Bezier over it, and the rule
 * that binds them - picking a preset drops the custom curve, because `bezier`
 * wins over `ease` when the renderer samples. Same bootstrap as the other store
 * tests: node environment, document stubbed.
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
const scaleKeys = () => clip().animation?.scale as Keyframe[];

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('a'));
  s().addClipFromAsset('a');
  // Two scale keys, at 0 and 1000 ms, and both of them boxed.
  s().toggleClipKeyframe(clip().id, 'scale', 0);
  s().updateClipTransformLive(clip().id, { scale: 1.5 }, 1000);
  s().setSelectedKeyframes(
    scaleKeys().map((k) => ({ clipId: clip().id, prop: 'scale' as const, t: k.t })),
  );
});

describe('setSelectedKeyframesEase', () => {
  it('eases every key of the box', () => {
    s().setSelectedKeyframesEase('hold');
    expect(scaleKeys().map((k) => k.ease)).toEqual(['hold', 'hold']);
  });

  it('drops a custom curve, so the preset is what actually plays', () => {
    s().setSelectedKeyframesBezier([0.9, 0.1, 0.1, 0.9]);
    s().setSelectedKeyframesEase('linear');
    expect(scaleKeys().every((k) => k.bezier === undefined)).toBe(true);
    expect(scaleKeys().map((k) => k.ease)).toEqual(['linear', 'linear']);
  });

  it('is one undo step', () => {
    s().setSelectedKeyframesEase('hold');
    s().undo();
    expect(scaleKeys().some((k) => k.ease === 'hold')).toBe(false);
  });
});

describe('setSelectedKeyframesBezier', () => {
  it('writes the curve on every key of the box', () => {
    s().setSelectedKeyframesBezier([0.2, 0.8, 0.4, 1]);
    expect(scaleKeys().map((k) => k.bezier)).toEqual([
      [0.2, 0.8, 0.4, 1],
      [0.2, 0.8, 0.4, 1],
    ]);
  });

  it('stores a copy, so a later edit cannot alias two keys together', () => {
    const curve: [number, number, number, number] = [0.2, 0.8, 0.4, 1];
    s().setSelectedKeyframesBezier(curve);
    expect(scaleKeys()[0]!.bezier).not.toBe(curve);
    expect(scaleKeys()[0]!.bezier).not.toBe(scaleKeys()[1]!.bezier);
  });

  it('null clears the curve and leaves the named easing in charge', () => {
    s().setSelectedKeyframesEase('out');
    s().setSelectedKeyframesBezier([0.2, 0.8, 0.4, 1]);
    s().setSelectedKeyframesBezier(null);
    expect(scaleKeys()[0]!.bezier).toBeUndefined();
    expect(scaleKeys()[0]!.ease).toBe('out');
  });

  it('does nothing with an empty selection', () => {
    s().setSelectedKeyframes([]);
    s().setSelectedKeyframesBezier([0.2, 0.8, 0.4, 1]);
    expect(scaleKeys().every((k) => k.bezier === undefined)).toBe(true);
  });
});
