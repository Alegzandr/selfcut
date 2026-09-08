import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset, Track } from '../types';

/**
 * FX on a whole lane.
 *
 * The rules that are easy to get wrong and impossible to see: a catalogue entry
 * has to be REFUSED by a lane that cannot mean it (rather than applied to
 * nothing), re-applying an effect the chain already runs must not stack a
 * second copy of it, and an emptied chain has to leave the field undefined -
 * an `audioFx: []` would make every "does this lane carry effects" check answer
 * yes for a lane carrying none.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function audioAsset(id: string): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp3`),
    kind: 'audio',
    durationMs: 5000,
    hasAudio: true,
    audioTracks: [{ index: 0, channels: 2 }],
    thumbnails: [],
  };
}

function videoAsset(id: string): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs: 5000,
    width: 1920,
    height: 1080,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const lane = (kind: Track['kind']) => s().project.tracks.find((t) => t.kind === kind)!;

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('v'));
  s().addAsset(audioAsset('a'));
  s().addClipFromAsset('v');
  s().addClipFromAsset('a');
});

describe('applyEffectToTrack', () => {
  it('grades a video lane', () => {
    expect(s().applyEffectToTrack(lane('video').id, 'bw')).toBe(true);
    expect(lane('video').color).toMatchObject({ saturation: -1 });
  });

  it('layers a grade onto the lane instead of flattening what is there', () => {
    s().applyEffectToTrack(lane('video').id, 'vignette');
    s().applyEffectToTrack(lane('video').id, 'sharpen');
    expect(lane('video').color).toMatchObject({ vignette: 0.5, sharpen: 0.5 });
  });

  it('chains an audio effect on an audio lane', () => {
    expect(s().applyEffectToTrack(lane('audio').id, 'reverb')).toBe(true);
    expect(lane('audio').audioFx).toEqual([{ type: 'reverb', amount: 0.5 }]);
  });

  it('refuses a grade on an audio lane and an effect chain on a video lane', () => {
    // A video lane's own sound is delegated to the audio lane its clips link
    // to, so its bus carries nothing an effect could process.
    expect(s().applyEffectToTrack(lane('audio').id, 'bw')).toBe(false);
    expect(s().applyEffectToTrack(lane('video').id, 'reverb')).toBe(false);
    expect(lane('audio').color).toBeUndefined();
    expect(lane('video').audioFx).toBeUndefined();
  });

  it('refuses an entry that only means something on a clip', () => {
    // A push-in is the clip's transform and Ken Burns drifts across the clip's
    // own length: a lane has neither.
    expect(s().applyEffectToTrack(lane('video').id, 'punchIn')).toBe(false);
    expect(s().applyEffectToTrack(lane('video').id, 'kenBurns')).toBe(false);
  });

  it('refuses a second copy of an effect the chain already runs', () => {
    s().applyEffectToTrack(lane('audio').id, 'bass');
    expect(s().applyEffectToTrack(lane('audio').id, 'bass')).toBe(false);
    expect(lane('audio').audioFx).toHaveLength(1);
  });

  it('is one undo step', () => {
    s().applyEffectToTrack(lane('video').id, 'warm');
    s().undo();
    expect(lane('video').color).toBeUndefined();
  });
});

describe('the lane grade', () => {
  it('writes one parameter without disturbing the rest', () => {
    s().setTrackColorLive(lane('video').id, 'contrast', 0.3);
    s().setTrackColorLive(lane('video').id, 'saturation', -0.2);
    expect(lane('video').color).toEqual({ contrast: 0.3, saturation: -0.2 });
  });

  it('takes a LUT at full strength, and dials it live', () => {
    s().setTrackLut(lane('video').id, 'l1');
    expect(lane('video').color?.lut).toEqual({ id: 'l1', intensity: 1 });
    s().setTrackLutIntensity(lane('video').id, 0.4);
    expect(lane('video').color?.lut).toEqual({ id: 'l1', intensity: 0.4 });
  });

  it('drops the LUT without dropping the grade around it', () => {
    s().setTrackColorLive(lane('video').id, 'contrast', 0.3);
    s().setTrackLut(lane('video').id, 'l1');
    s().setTrackLut(lane('video').id, null);
    expect(lane('video').color?.lut).toBeUndefined();
    expect(lane('video').color?.contrast).toBe(0.3);
  });

  it('ignores an intensity aimed at a lane carrying no LUT', () => {
    s().setTrackLutIntensity(lane('video').id, 0.4);
    expect(lane('video').color).toBeUndefined();
  });

  it('resets to no grade at all, in one undo step', () => {
    s().setTrackColorLive(lane('video').id, 'contrast', 0.3);
    s().setTrackLut(lane('video').id, 'l1');
    s().resetTrackColor(lane('video').id);
    expect(lane('video').color).toBeUndefined();
    s().undo();
    expect(lane('video').color?.contrast).toBe(0.3);
  });
});

describe('the lane chain', () => {
  it('dials one effect and leaves its neighbours alone', () => {
    s().applyEffectToTrack(lane('audio').id, 'leveler');
    s().applyEffectToTrack(lane('audio').id, 'echo');
    s().setTrackAudioFxAmount(lane('audio').id, 'echo', 0.9);
    expect(lane('audio').audioFx).toEqual([
      { type: 'leveler', amount: 0.5 },
      { type: 'echo', amount: 0.9 },
    ]);
  });

  it('drops the field entirely on the last removal, never leaving an empty array', () => {
    s().applyEffectToTrack(lane('audio').id, 'voice');
    s().removeTrackAudioFx(lane('audio').id, 'voice');
    expect(lane('audio').audioFx).toBeUndefined();
  });

  it('keeps the rest of the chain when one effect is removed', () => {
    s().applyEffectToTrack(lane('audio').id, 'voice');
    s().applyEffectToTrack(lane('audio').id, 'bass');
    s().removeTrackAudioFx(lane('audio').id, 'voice');
    expect(lane('audio').audioFx).toEqual([{ type: 'bass', amount: 0.5 }]);
  });
});

describe('the FX pane and the clip selection', () => {
  it('put each other away: a lane and a clip are two things to point at', () => {
    s().setFxTrack(lane('video').id);
    expect(s().fxTrackId).toBe(lane('video').id);
    s().selectClip(lane('video').clips[0]!.id);
    expect(s().fxTrackId).toBeNull();
  });
});
