import { describe, it, expect } from 'vitest';
import type { ClipColor, Track } from '../types';
import { resolveTrackBlur, resolveTrackColor, trackAudioFx, trackHasPictureFx } from './track';

/**
 * A lane's FX, resolved.
 *
 * Two things matter here and both are about what does NOT happen: a lane with
 * no grade, or a grade at the identity, must resolve to null so the compositor
 * skips the extra track pass entirely - it is a full-frame draw and a WebGL
 * pass per graded lane per frame - and a lane's channels must read as constants
 * at one fixed instant, since a track has no local time to animate against.
 */

function track(over: Partial<Track> = {}): Track {
  return { id: 't1', kind: 'video', clips: [], ...over };
}

const color = (c: ClipColor): Track => track({ color: c });

describe('resolveTrackColor', () => {
  it('is null for a lane with no grade', () => {
    expect(resolveTrackColor(track())).toBeNull();
  });

  it('is null for a grade whose every channel sits at the identity', () => {
    expect(resolveTrackColor(color({ brightness: 0, saturation: 0 }))).toBeNull();
  });

  it('resolves the channels a lane does carry', () => {
    const r = resolveTrackColor(color({ contrast: 0.4, saturation: -0.2 }));
    expect(r?.contrast).toBeCloseTo(0.4, 6);
    expect(r?.saturation).toBeCloseTo(-0.2, 6);
    // Everything untouched stays at the identity rather than going undefined.
    expect(r?.brightness).toBe(0);
  });

  it('carries a LUT through, so a whole lane can be graded by one table', () => {
    const r = resolveTrackColor(color({ lut: { id: 'l1', intensity: 0.5 } }));
    expect(r?.lut).toEqual({ id: 'l1', intensity: 0.5 });
  });

  it('reads a keyframed channel at one fixed instant, never over time', () => {
    // A lane cannot animate (see `Track.color`), but the field's type allows
    // keyframes: whatever is there resolves to the value at local 0, not to an
    // undefined the pass would then have to guess at.
    const r = resolveTrackColor(
      color({ brightness: [{ t: 0, value: 0.25 }, { t: 1000, value: 1 }] }),
    );
    expect(r?.brightness).toBeCloseTo(0.25, 6);
  });
});

describe('resolveTrackBlur', () => {
  it('is 0 for a lane with no grade, and for a grade that only touches colour', () => {
    expect(resolveTrackBlur(track())).toBe(0);
    expect(resolveTrackBlur(color({ saturation: 0.5 }))).toBe(0);
  });

  it('is read apart from the grade: blur alone leaves the colour pass at null', () => {
    const t = color({ blur: 0.5 });
    expect(resolveTrackBlur(t)).toBe(0.5);
    expect(resolveTrackColor(t)).toBeNull();
  });

  it('clamps to 0..1, whatever a hand-edited project holds', () => {
    expect(resolveTrackBlur(color({ blur: 4 }))).toBe(1);
    expect(resolveTrackBlur(color({ blur: -2 }))).toBe(0);
  });
});

describe('trackHasPictureFx', () => {
  it('is false when there is nothing to draw a second pass for', () => {
    expect(trackHasPictureFx(track())).toBe(false);
    expect(trackHasPictureFx(color({}))).toBe(false);
    expect(trackHasPictureFx(color({ contrast: 0 }))).toBe(false);
  });

  it('is true for a grade, and for a blur the grade does not carry', () => {
    expect(trackHasPictureFx(color({ contrast: 0.2 }))).toBe(true);
    expect(trackHasPictureFx(color({ blur: 0.2 }))).toBe(true);
  });

  it('is false for an audio chain: that is not a picture pass', () => {
    expect(trackHasPictureFx(track({ audioFx: [{ type: 'reverb', amount: 1 }] }))).toBe(false);
  });
});

describe('trackAudioFx', () => {
  it('is null for a lane with no chain, and for an empty one', () => {
    expect(trackAudioFx(track())).toBeNull();
    expect(trackAudioFx(track({ audioFx: [] }))).toBeNull();
  });

  it('drops effects dialled to zero: they are in the list but not in the sound', () => {
    const t = track({
      audioFx: [
        { type: 'leveler', amount: 0 },
        { type: 'bass', amount: 0.4 },
      ],
    });
    expect(trackAudioFx(t)).toEqual([{ type: 'bass', amount: 0.4 }]);
  });

  it('is null when every effect of the chain is at zero', () => {
    expect(trackAudioFx(track({ audioFx: [{ type: 'echo', amount: 0 }] }))).toBeNull();
  });
});
