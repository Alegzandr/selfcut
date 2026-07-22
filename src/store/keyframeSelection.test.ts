import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { KeyframeRef, MediaAsset } from '../types';
import {
  keyframeKey,
  keyframesInBox,
  selectionDragBounds,
} from '../timeline/keyframeSelection';
import {
  trackTops,
  trackLanes,
  KEYFRAME_LANE_HEIGHT_PX,
  KEYFRAME_LANES_GAP_PX,
  lanesHeightPx,
} from '../timeline/trackHeight';

/**
 * Box-selecting keyframes: which diamonds a marquee encloses, how far the boxed
 * set may slide, and the batch edits that run off it. Store bootstrapped like
 * proInteractions.test.ts: node environment, so document is stubbed.
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

/** The single video clip on the timeline. */
const clip = () => s().project.tracks.flatMap((t) => t.clips)[0]!;

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('v', 5000));
  s().addClipFromAsset('v');
  // Two properties keyed at the same three times, so a box that takes only one
  // lane can be told apart from one that takes the whole column.
  s().updateClip(clip().id, {
    animation: {
      scale: [
        { t: 0, value: 1 },
        { t: 1000, value: 2 },
        { t: 2000, value: 1 },
      ],
      opacity: [
        { t: 0, value: 1 },
        { t: 1000, value: 0.5 },
        { t: 2000, value: 1 },
      ],
    },
  });
});

/** Y of the middle of the lane at `laneIndex`, for a track showing `laneCount` lanes. */
function laneMidY(rowBottom: number, laneCount: number, laneIndex: number): number {
  return (
    rowBottom -
    lanesHeightPx(laneCount) +
    KEYFRAME_LANES_GAP_PX +
    laneIndex * KEYFRAME_LANE_HEIGHT_PX +
    KEYFRAME_LANE_HEIGHT_PX / 2
  );
}

describe('keyframesInBox', () => {
  it('takes only the keys of the lanes it crosses', () => {
    const tracks = s().project.tracks;
    const expanded = new Set([tracks[0]!.id]);
    const tops = trackTops(tracks, s().trackHeightPx, expanded);
    // Lane 0 is `scale` (TRANSFORM_LANE_PROPS order); band it alone.
    const y = laneMidY(tops[1]!, trackLanes(tracks[0]!).length, 0);
    const hits = keyframesInBox(tracks, expanded, tops, { minY: y - 1, maxY: y + 1, t0: 0, t1: 3000 });
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((h) => h.prop))).toEqual(new Set(['scale']));
  });

  it('clips the set to the time span of the box', () => {
    const tracks = s().project.tracks;
    const expanded = new Set([tracks[0]!.id]);
    const tops = trackTops(tracks, s().trackHeightPx, expanded);
    const y = laneMidY(tops[1]!, trackLanes(tracks[0]!).length, 0);
    const hits = keyframesInBox(tracks, expanded, tops, {
      minY: y - 1,
      maxY: y + 1,
      t0: 900,
      t1: 1100,
    });
    expect(hits.map((h) => h.t)).toEqual([1000]);
  });

  it('grows a lane for a colour param once it carries a key, and boxes it', () => {
    const tracks0 = s().project.tracks;
    const before = trackLanes(tracks0[0]!).length;
    const expanded = new Set([tracks0[0]!.id]);
    const heightBefore = trackTops(tracks0, s().trackHeightPx, expanded)[1]!;

    s().toggleClipKeyframe(clip().id, 'contrast', 1000);

    const tracks = s().project.tracks;
    const lanes = trackLanes(tracks[0]!);
    expect(lanes.length).toBe(before + 1);
    // Colour lanes stack under the fixed transform set, never among it.
    expect(lanes[lanes.length - 1]).toBe('contrast');

    const tops = trackTops(tracks, s().trackHeightPx, expanded);
    expect(tops[1]!).toBe(heightBefore + KEYFRAME_LANE_HEIGHT_PX);

    const y = laneMidY(tops[1]!, lanes.length, lanes.length - 1);
    const hits = keyframesInBox(tracks, expanded, tops, {
      minY: y - 1,
      maxY: y + 1,
      t0: 0,
      t1: 5000,
    });
    expect(hits).toEqual([{ clipId: clip().id, prop: 'contrast', t: 1000 }]);
  });

  it('keeps a colour lane alive when a drag clamps its keys onto one time', () => {
    // The row height must not change under a drag in flight. Dragging can only
    // clamp keys, never remove them, so the lane survives even when the whole
    // selection piles onto the clip's last instant.
    const id = clip().id;
    s().updateClip(id, {
      color: {
        contrast: [
          { t: 1000, value: 0.1 },
          { t: 2000, value: 0.9 },
        ],
      },
    });
    s().setSelectedKeyframes([
      { clipId: id, prop: 'contrast', t: 1000 },
      { clipId: id, prop: 'contrast', t: 2000 },
    ]);
    s().moveSelectedKeyframes(50000);
    expect(trackLanes(s().project.tracks[0]!)).toContain('contrast');
  });

  it('keeps the transform lanes when a colour param has no key', () => {
    // The seven colour params must not each claim a permanently empty strip.
    expect(trackLanes(s().project.tracks[0]!)).toEqual(['scale', 'x', 'y', 'rotation', 'opacity']);
  });

  it('ignores collapsed tracks - they show no lanes to box', () => {
    const tracks = s().project.tracks;
    const tops = trackTops(tracks, s().trackHeightPx, new Set());
    const hits = keyframesInBox(tracks, new Set(), tops, {
      minY: 0,
      maxY: tops[1]!,
      t0: 0,
      t1: 5000,
    });
    expect(hits).toEqual([]);
  });
});

describe('selectionDragBounds', () => {
  const ref = (prop: 'scale' | 'opacity', t: number): KeyframeRef => ({
    clipId: clip().id,
    prop,
    t,
  });

  it('stops a single key at its unselected neighbours', () => {
    const [lo, hi] = selectionDragBounds(s().project, [ref('scale', 1000)]);
    // Neighbours at 0 and 2000, minus the 1ms same-key epsilon on each side.
    expect(lo).toBe(-999);
    expect(hi).toBe(999);
  });

  it('lets a set slide past its own members', () => {
    const [lo, hi] = selectionDragBounds(s().project, [ref('scale', 1000), ref('scale', 2000)]);
    // 1000 is free to the left down to 0's neighbour; 2000 is capped by the
    // clip end, and the tightest bound of the pair wins on each side.
    expect(lo).toBe(-999);
    expect(hi).toBe(clipEnd() - 2000);
  });

  it('takes the tightest bound of the set on each side', () => {
    // Boxing 0 and 2000 leaves 1000 unselected between them: the key at 0 is
    // the one that would hit it, and the key at 0 is also already hard left.
    const [lo, hi] = selectionDragBounds(s().project, [ref('scale', 0), ref('scale', 2000)]);
    expect(lo).toBe(0);
    expect(hi).toBe(999);
  });
});

/** Clip-local ms of the clip's end. */
function clipEnd(): number {
  const c = clip();
  return c.sourceOutMs - c.sourceInMs;
}

describe('moveSelectedKeyframes', () => {
  it('slides the boxed set and rewrites the selection to the new times', () => {
    const id = clip().id;
    s().setSelectedKeyframes([{ clipId: id, prop: 'scale', t: 1000 }]);
    s().moveSelectedKeyframes(500);
    expect(clip().animation!.scale!.map((k) => k.t)).toEqual([0, 1500, 2000]);
    // The untouched property stays put: these lanes edit one property apart.
    expect(clip().animation!.opacity!.map((k) => k.t)).toEqual([0, 1000, 2000]);
    expect(s().selectedKeyframes.map((k) => k.t)).toEqual([1500]);
  });

  it('keeps relative spacing when several keys move together', () => {
    const id = clip().id;
    s().setSelectedKeyframes([
      { clipId: id, prop: 'scale', t: 1000 },
      { clipId: id, prop: 'scale', t: 2000 },
    ]);
    s().moveSelectedKeyframes(300);
    expect(clip().animation!.scale!.map((k) => k.t)).toEqual([0, 1300, 2300]);
  });
});

describe('deleteSelectedKeyframes', () => {
  it('removes only the boxed keys and clears the selection', () => {
    const id = clip().id;
    s().setSelectedKeyframes([{ clipId: id, prop: 'scale', t: 1000 }]);
    s().deleteSelectedKeyframes();
    expect(clip().animation!.scale!.map((k) => k.t)).toEqual([0, 2000]);
    expect(clip().animation!.opacity).toHaveLength(3);
    expect(s().selectedKeyframes).toEqual([]);
  });

  it('collapses a property back to a constant when its last key goes', () => {
    const id = clip().id;
    s().setSelectedKeyframes(
      [0, 1000, 2000].map((t) => ({ clipId: id, prop: 'scale' as const, t })),
    );
    s().deleteSelectedKeyframes();
    expect(clip().animation?.scale).toBeUndefined();
    // The look it collapsed to is preserved as the static value.
    expect(clip().transform?.scale).toBe(1);
  });

  it('is undoable as one step', () => {
    const id = clip().id;
    s().setSelectedKeyframes([{ clipId: id, prop: 'scale', t: 1000 }]);
    s().deleteSelectedKeyframes();
    s().undo();
    expect(clip().animation!.scale!.map((k) => k.t)).toEqual([0, 1000, 2000]);
  });
});

describe('setSelectedKeyframesEase', () => {
  it('re-eases every boxed key across properties, leaving the rest alone', () => {
    const id = clip().id;
    s().setSelectedKeyframes([
      { clipId: id, prop: 'scale', t: 1000 },
      { clipId: id, prop: 'opacity', t: 2000 },
    ]);
    s().setSelectedKeyframesEase('hold');
    expect(clip().animation!.scale!.map((k) => k.ease)).toEqual([undefined, 'hold', undefined]);
    expect(clip().animation!.opacity!.map((k) => k.ease)).toEqual([undefined, undefined, 'hold']);
  });
});

describe('keyframe selection lifecycle', () => {
  it('is dropped by a plain clip selection', () => {
    const id = clip().id;
    s().setSelectedKeyframes([{ clipId: id, prop: 'scale', t: 1000 }]);
    s().selectClip(id);
    expect(s().selectedKeyframes).toEqual([]);
  });

  it('is pruned when the clip holding the keys is deleted', () => {
    const id = clip().id;
    s().setSelectedKeyframes([{ clipId: id, prop: 'scale', t: 1000 }]);
    s().deleteClips([id], false);
    expect(s().selectedKeyframes).toEqual([]);
  });

  it('names a key by clip, property and time', () => {
    expect(keyframeKey({ clipId: 'c1', prop: 'scale', t: 1000.4 })).toBe('c1:scale:1000');
  });
});
