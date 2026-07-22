import { describe, it, expect } from 'vitest';
import type { Clip, Keyframe } from '../types';
import { sampleChannel } from '../model';
import { presetPatch, truncateChannel } from './presetApply';
import type { PresetLook } from './presetFile';

/**
 * Applying a preset to a clip that is not the one it came from: what a keyframe
 * past the end becomes, what the target keeps, and what a clip that cannot take
 * a section is spared.
 */

const PICTURE = { hasPicture: true, hasAudio: true };

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    kind: 'media',
    assetId: 'a1',
    trackId: 'tr-v',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 2000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  } as Clip;
}

describe('truncateChannel', () => {
  it('keeps a key sitting exactly on the clip end', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 1 },
      { t: 2000, value: 2 },
    ];
    expect(truncateChannel(keys, 2000)).toEqual(keys);
  });

  it('drops a key past the end', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 1 },
      { t: 2002, value: 2 },
    ];
    expect(truncateChannel(keys, 2000)).toEqual([{ t: 0, value: 1 }]);
  });

  it('collapses to the first value when no key survives', () => {
    const keys: Keyframe[] = [
      { t: 3000, value: 0.4 },
      { t: 4000, value: 0.9 },
    ];
    // sampleChannel would have held at 0.4 for the clip's whole life anyway.
    expect(truncateChannel(keys, 2000)).toBe(0.4);
  });

  it('de-duplicates keys the clamp collided, preserving order', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 1 },
      { t: 2000, value: 2 },
      { t: 2000.4, value: 3 },
    ];
    expect(truncateChannel(keys, 2000)).toEqual([
      { t: 0, value: 1 },
      { t: 2000, value: 2 },
    ]);
  });

  it('leaves a constant channel alone', () => {
    expect(truncateChannel(0.7, 2000)).toBe(0.7);
  });

  it('samples identically to the source when everything fits', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 1 },
      { t: 800, value: 1.6, ease: 'out' },
      { t: 1900, value: 1.1, ease: 'hold' },
    ];
    const applied = truncateChannel(keys, 2000);
    for (let t = 0; t <= 2000; t += 100) {
      expect(sampleChannel(applied, t)).toBeCloseTo(sampleChannel(keys, t), 10);
    }
  });
});

describe('presetPatch', () => {
  it("preserves the target's crop while taking the preset's placement", () => {
    const target = clip({
      transform: { crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }, x: 0.5, y: 0.5, scale: 1 },
    });
    const look: PresetLook = { transform: { x: 0.3, y: 0.7, scale: 1.8, rotation: 12 } };
    const { patch } = presetPatch(look, target, 2000, PICTURE);
    expect(patch.transform).toEqual({
      crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 },
      x: 0.3,
      y: 0.7,
      scale: 1.8,
      rotation: 12,
    });
  });

  it('folds a fully out-of-range scale animation into the transform', () => {
    const look: PresetLook = {
      animation: {
        scale: [
          { t: 3000, value: 2 },
          { t: 3500, value: 3 },
        ],
      },
    };
    const { patch, truncated } = presetPatch(look, clip(), 2000, PICTURE);
    expect(truncated).toBe(true);
    expect(patch.animation).toBeUndefined();
    expect(patch.transform?.scale).toBe(2);
  });

  it('keeps a fully out-of-range opacity animated, since it has no static field', () => {
    const look: PresetLook = {
      animation: {
        opacity: [
          { t: 3000, value: 0.25 },
          { t: 3500, value: 1 },
        ],
      },
    };
    const { patch } = presetPatch(look, clip(), 2000, PICTURE);
    expect(patch.animation?.opacity).toEqual([{ t: 0, value: 0.25 }]);
  });

  it('reports no truncation when everything fits', () => {
    const look: PresetLook = { animation: { scale: [{ t: 0, value: 1 }, { t: 500, value: 2 }] } };
    expect(presetPatch(look, clip(), 2000, PICTURE).truncated).toBe(false);
  });

  it('replaces the whole animation section rather than merging into it', () => {
    const target = clip({ animation: { x: [{ t: 0, value: 0.2 }] } });
    const look: PresetLook = { animation: { scale: [{ t: 0, value: 1.5 }] } };
    const { patch } = presetPatch(look, target, 2000, PICTURE);
    expect(patch.animation).toEqual({ scale: [{ t: 0, value: 1.5 }] });
    expect(patch.animation?.x).toBeUndefined();
  });

  it('replaces the audio chain rather than appending to it', () => {
    const target = clip({ audioFx: [{ type: 'reverb', amount: 0.9 }] });
    const look: PresetLook = { audioFx: [{ type: 'bass', amount: 0.4 }] };
    const { patch } = presetPatch(look, target, 2000, PICTURE);
    expect(patch.audioFx).toEqual([{ type: 'bass', amount: 0.4 }]);
  });

  it('spares an audio-only clip every picture section', () => {
    const look: PresetLook = {
      color: { saturation: 0.5 },
      transform: { x: 0.5, y: 0.5, scale: 2 },
      zoomEnd: 1.4,
      audioFx: [{ type: 'voice', amount: 0.5 }],
    };
    const r = presetPatch(look, clip(), 2000, { hasPicture: false, hasAudio: true });
    expect(r.patch).toEqual({ audioFx: [{ type: 'voice', amount: 0.5 }] });
    expect(r.skippedPicture).toBe(true);
    expect(r.skippedAudio).toBe(false);
  });

  it('yields an empty patch when the clip can take nothing, so it is not a target', () => {
    const look: PresetLook = { color: { saturation: 0.5 } };
    const r = presetPatch(look, clip(), 2000, { hasPicture: false, hasAudio: true });
    expect(r.patch).toEqual({});
  });

  it('trims colour keyframes against the target and flags it', () => {
    const look: PresetLook = {
      color: { brightness: [{ t: 0, value: 0 }, { t: 2500, value: 0.5 }] },
    };
    const { patch, truncated } = presetPatch(look, clip(), 2000, PICTURE);
    expect(truncated).toBe(true);
    expect(patch.color?.brightness).toEqual([{ t: 0, value: 0 }]);
  });
});
