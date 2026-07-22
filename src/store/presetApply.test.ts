import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import type { PresetLook } from '../effects/presetFile';

/**
 * Applying a `.sfx` preset through the store: that a whole batch is one undo
 * step, that the audio half follows the linked-partner redirect, and that a
 * clip which can take nothing is not counted as a target.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function asset(id: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset {
  return {
    id,
    file: new File([], `${id}.${kind === 'audio' ? 'mp3' : 'mp4'}`),
    kind,
    durationMs: 5000,
    ...(kind === 'audio' ? {} : { width: 1920, height: 1080 }),
    hasAudio,
    audioTracks: hasAudio ? [{ index: 0, channels: 2 }] : [],
    thumbnails: [],
  } as MediaAsset;
}

const s = () => useStore.getState();
const videoClip = () => s().project.tracks.find((t) => t.kind === 'video')!.clips[0]!;

const LOOK: PresetLook = {
  color: { saturation: 0.4 },
  audioFx: [{ type: 'reverb', amount: 0.3 }],
};

beforeEach(() => {
  s().resetProject();
});

describe('applyClipPreset', () => {
  it('applies picture sections and reports the clip as changed', () => {
    s().addAsset(asset('a', 'video', false));
    s().addClipFromAsset('a');
    const { changed, truncated } = s().applyClipPreset({ color: { saturation: 0.4 } }, [
      videoClip().id,
    ]);
    expect(changed).toEqual([videoClip().id]);
    expect(truncated).toBe(false);
    expect(videoClip().color?.saturation).toBe(0.4);
  });

  it('is a single undo step across a multi-clip selection', () => {
    s().addAsset(asset('a', 'video', false));
    s().addClipFromAsset('a');
    s().addClipFromAsset('a');
    const track = s().project.tracks.find((t) => t.kind === 'video')!;
    const ids = track.clips.map((c) => c.id);
    expect(ids.length).toBe(2);

    const before = s().past.length;
    s().applyClipPreset({ color: { saturation: 0.4 } }, ids);
    expect(s().past.length).toBe(before + 1);

    s().undo();
    for (const c of s().project.tracks.find((t) => t.kind === 'video')!.clips) {
      expect(c.color).toBeUndefined();
    }
  });

  it('leaves an audio-only clip untouched by a picture-only preset', () => {
    s().addAsset(asset('m', 'audio', true));
    s().addClipFromAsset('m');
    const audio = s().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    const { changed } = s().applyClipPreset({ color: { saturation: 0.4 } }, [audio.id]);
    expect(changed).toEqual([]);
    expect(audio.color).toBeUndefined();
  });

  it('trims keyframes against the target and reports it', () => {
    s().addAsset(asset('a', 'video', false));
    s().addClipFromAsset('a');
    const look: PresetLook = {
      animation: {
        scale: [
          { t: 0, value: 1 },
          { t: 9000, value: 2 },
        ],
      },
    };
    const { truncated } = s().applyClipPreset(look, [videoClip().id]);
    expect(truncated).toBe(true);
    // The clip runs 5000 ms, so the 9000 ms key cannot survive.
    expect(videoClip().animation?.scale).toEqual([{ t: 0, value: 1 }]);
  });

  it('sends the audio half to the linked partner and keeps the grade on the picture', () => {
    s().addAsset(asset('v', 'video', true));
    s().addClipFromAsset('v'); // splits into a linked picture + audio pair
    const picture = videoClip();
    const sound = s().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect(sound.linkId).toBe(picture.linkId);

    const { changed } = s().applyClipPreset(LOOK, [picture.id]);
    expect(new Set(changed)).toEqual(new Set([picture.id, sound.id]));

    const after = s().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect(videoClip().color?.saturation).toBe(0.4);
    expect(videoClip().audioFx).toBeUndefined();
    expect(after.audioFx).toEqual([{ type: 'reverb', amount: 0.3 }]);
  });

  it('clears a keyframe box-selection, whose refs the trimming may have invalidated', () => {
    s().addAsset(asset('a', 'video', false));
    s().addClipFromAsset('a');
    const id = videoClip().id;
    s().toggleClipKeyframe(id, 'scale', 0);
    s().setSelectedKeyframes([{ clipId: id, prop: 'scale', t: 0 }]);
    expect(s().selectedKeyframes.length).toBe(1);
    s().applyClipPreset(LOOK, [id]);
    expect(s().selectedKeyframes).toEqual([]);
  });
});
