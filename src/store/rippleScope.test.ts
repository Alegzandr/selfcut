import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { MediaAsset, Track } from '../types';

/**
 * The ripple preference: how far a ripple delete, a closed gap or a ripple trim
 * reaches. Off (the default) each track closes its own hole, which is what this
 * editor has always done; on, the span comes out of the whole timeline and the
 * lanes stay in sync with each other.
 *
 * Store bootstrapped like proEditing.test.ts: node environment, so document is
 * stubbed before the module graph is pulled in.
 */

let useStore: typeof import('./store').useStore;
// Imported with the store rather than at the top of the file: this module pulls
// the app's i18n in, which touches `document` the moment it is evaluated.
let rippleForTrim: typeof import('../timeline/clipDrag').rippleForTrim;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
  ({ rippleForTrim } = await import('../timeline/clipDrag'));
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
const videoTracks = (): Track[] => s().project.tracks.filter((t) => t.kind === 'video');
const startsOn = (track: Track) =>
  s()
    .project.tracks.find((t) => t.id === track.id)!
    .clips.map((c) => c.timelineStartMs)
    .sort((a, b) => a - b);
const clipAt = (track: Track, startMs: number) =>
  s().project.tracks.find((t) => t.id === track.id)!.clips.find((c) => c.timelineStartMs === startMs)!;

/**
 * V1: three 5 s clips end to end. V2: one 5 s clip over the middle of them.
 * The layout every case below rips a hole in.
 */
function twoLanes() {
  s().addAsset(videoAsset('v'));
  s().addClipFromAsset('v');
  s().addClipFromAssetAt('v', 5000);
  s().addClipFromAssetAt('v', 10000);
  s().addTrack('video');
  const [v1, v2] = videoTracks();
  s().addClipFromAssetAt('v', 5000, v2!.id);
  return { v1: v1!, v2: v2! };
}

beforeEach(() => {
  s().resetProject();
  s().setRippleAcrossTracks(false);
});

describe('ripple delete', () => {
  it('closes the hole on its own track only, by default', () => {
    const { v1, v2 } = twoLanes();
    s().deleteClips([clipAt(v1, 5000).id], true);
    expect(startsOn(v1)).toEqual([0, 5000]);
    // The Vegas rule: V2 keeps its timing, whatever V1 just lost.
    expect(startsOn(v2)).toEqual([5000]);
  });

  it('takes the span out of every track when the preference asks for it', () => {
    const { v1, v2 } = twoLanes();
    s().setRippleAcrossTracks(true);
    s().deleteClips([clipAt(v1, 5000).id], true);
    expect(startsOn(v1)).toEqual([0, 5000]);
    expect(startsOn(v2)).toEqual([0]);
  });

  it('counts a span deleted on two lanes at once only once', () => {
    const { v1, v2 } = twoLanes();
    s().setRippleAcrossTracks(true);
    // Both clips cover 5000-10000, so five seconds leave the timeline, not ten.
    s().deleteClips([clipAt(v1, 5000).id, clipAt(v2, 5000).id], true);
    expect(startsOn(v1)).toEqual([0, 5000]);
    expect(startsOn(v2)).toEqual([]);
  });

  it('leaves a locked track where it is', () => {
    const { v1, v2 } = twoLanes();
    s().setRippleAcrossTracks(true);
    s().toggleTrackLocked(v2.id);
    s().deleteClips([clipAt(v1, 5000).id], true);
    expect(startsOn(v1)).toEqual([0, 5000]);
    expect(startsOn(v2)).toEqual([5000]);
  });

  it('still leaves everything in place without the ripple flag', () => {
    const { v1, v2 } = twoLanes();
    s().setRippleAcrossTracks(true);
    s().deleteClips([clipAt(v1, 5000).id], false);
    expect(startsOn(v1)).toEqual([0, 10000]);
    expect(startsOn(v2)).toEqual([5000]);
  });
});

describe('close gap, ripple on every track', () => {
  /** V1: a clip at 0 and one at 10000, so a hole over 5000-10000. */
  function gapOnV1() {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    s().addClipFromAssetAt('v', 10000);
    s().addTrack('video');
    const [v1, v2] = videoTracks();
    s().setRippleAcrossTracks(true);
    return { v1: v1!, v2: v2! };
  }

  it('closes the span nothing is playing over, on both tracks', () => {
    const { v1, v2 } = gapOnV1();
    s().addClipFromAssetAt('v', 15000, v2.id);
    s().closeGap(v1.id, 6000);
    expect(startsOn(v1)).toEqual([0, 5000]);
    expect(startsOn(v2)).toEqual([10000]);
  });

  it('stops at the first thing playing on another lane', () => {
    const { v1, v2 } = gapOnV1();
    // V2 starts at 7000, so only 5000-7000 is empty across the timeline.
    s().addClipFromAssetAt('v', 7000, v2.id);
    s().closeGap(v1.id, 6000);
    expect(startsOn(v1)).toEqual([0, 8000]);
    expect(startsOn(v2)).toEqual([5000]);
  });

  it('does nothing when another lane is playing over the gap', () => {
    const { v1, v2 } = gapOnV1();
    s().addClipFromAssetAt('v', 4000, v2.id);
    const before = s().past.length;
    s().closeGap(v1.id, 6000);
    expect(startsOn(v1)).toEqual([0, 10000]);
    expect(startsOn(v2)).toEqual([4000]);
    // Not an undo step either: nothing was closed.
    expect(s().past.length).toBe(before);
  });

  it('closes each track on its own when the preference is off', () => {
    const { v1, v2 } = gapOnV1();
    s().setRippleAcrossTracks(false);
    s().addClipFromAssetAt('v', 15000, v2.id);
    s().closeGap(v1.id, 6000);
    expect(startsOn(v1)).toEqual([0, 5000]);
    expect(startsOn(v2)).toEqual([15000]);
  });
});

describe('rippleForTrim', () => {
  it('captures this track only by default', () => {
    const { v1 } = twoLanes();
    const captured = rippleForTrim(s().project, clipAt(v1, 0), 'right');
    expect(captured.map((c) => c.startMs).sort((a, b) => a - b)).toEqual([5000, 10000]);
  });

  it('captures every lane in front of the edited edge when asked to', () => {
    const { v1 } = twoLanes();
    const captured = rippleForTrim(s().project, clipAt(v1, 0), 'right', true);
    // V1's two downstream clips, plus V2's - which starts exactly at the edge.
    expect(captured.map((c) => c.startMs).sort((a, b) => a - b)).toEqual([5000, 5000, 10000]);
  });

  it('leaves a clip already playing across the edit point alone', () => {
    const { v1, v2 } = twoLanes();
    s().moveClips([{ clipId: clipAt(v2, 5000).id, timelineStartMs: 3000 }]);
    const captured = rippleForTrim(s().project, clipAt(v1, 0), 'right', true);
    expect(captured.map((c) => c.startMs).sort((a, b) => a - b)).toEqual([5000, 10000]);
  });
});
