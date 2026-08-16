import { describe, expect, it } from 'vitest';
import {
  clipsAt,
  forEachUpcomingVideoClip,
  forEachVisibleVideoClip,
  maskDirtyRect,
  visibleVideoClips,
} from './compositor';
import type { Clip, ClipMask, MediaClip, Track } from '../types';

/** A media clip on the timeline from `startMs` for `durMs`. */
function clip(id: string, startMs: number, durMs: number, speed = 1): MediaClip {
  return {
    kind: 'media',
    id,
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: durMs * speed,
    speed,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
}

function track(clips: Clip[], over: Partial<Track> = {}): Track {
  return { id: 't1', kind: 'video', clips, ...over };
}

/**
 * The definition `clipsAt` replaced: a linear scan and a sort. Kept here as the
 * oracle the indexed implementation is differentially tested against, because
 * "faster" is only worth anything if it also still answers the same question.
 */
function referenceClipsAt(clips: Clip[], tMs: number): Clip[] {
  return clips
    .filter((c) => {
      const dur = (c.sourceOutMs - c.sourceInMs) / c.speed;
      return tMs >= c.timelineStartMs && tMs < c.timelineStartMs + dur;
    })
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
}

describe('clipsAt', () => {
  const clips = [clip('a', 0, 1000), clip('b', 800, 1000), clip('c', 3000, 500)];

  it('is half-open: a clip is visible at its start, not at its end', () => {
    expect(clipsAt(clips, 0).map((c) => c.id)).toEqual(['a']);
    expect(clipsAt(clips, 999).map((c) => c.id)).toEqual(['a', 'b']);
    expect(clipsAt(clips, 1000).map((c) => c.id)).toEqual(['b']);
  });

  it('returns an overlapping pair in start order, so the incoming clip draws last', () => {
    expect(clipsAt(clips, 900).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('finds nothing in a gap, before the first clip or after the last', () => {
    expect(clipsAt(clips, 2000)).toEqual([]);
    expect(clipsAt(clips, -1)).toEqual([]);
    expect(clipsAt(clips, 99999)).toEqual([]);
  });

  it('honours speed when computing a clip end', () => {
    // 2000 ms of source at 2x occupies 1000 ms of timeline.
    const fast = [clip('f', 0, 1000, 2)];
    expect(clipsAt(fast, 999)).toHaveLength(1);
    expect(clipsAt(fast, 1001)).toHaveLength(0);
  });

  it('does not care what order the clips are stored in', () => {
    const shuffled = [clip('c', 3000, 500), clip('b', 800, 1000), clip('a', 0, 1000)];
    expect(clipsAt(shuffled, 900).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('agrees with the linear scan it replaced, on a long random timeline', () => {
    // A deterministic pseudo-random layout: overlaps, gaps, nesting, zero-length
    // neighbours. The index only pays off if it is exact on all of them.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const many: Clip[] = [];
    for (let i = 0; i < 400; i++) {
      many.push(clip(`c${i}`, Math.round(rand() * 60000), 1 + Math.round(rand() * 4000)));
    }
    for (let t = -500; t <= 61000; t += 137) {
      expect(clipsAt(many, t).map((c) => c.id)).toEqual(referenceClipsAt(many, t).map((c) => c.id));
    }
  });

  it('reuses its index across calls without going stale on an edit', () => {
    const clips2 = [clip('a', 0, 1000)];
    expect(clipsAt(clips2, 500)).toHaveLength(1);
    // Copy-on-write: an edit yields a NEW array, which must be re-indexed.
    const edited = [clip('a', 2000, 1000)];
    expect(clipsAt(edited, 500)).toHaveLength(0);
    expect(clipsAt(edited, 2500)).toHaveLength(1);
  });
});

describe('forEachVisibleVideoClip', () => {
  it('yields the same thing the array form does', () => {
    const t = track([clip('a', 0, 1000), clip('b', 800, 1000)]);
    const seen: string[] = [];
    forEachVisibleVideoClip(t, 900, (c) => seen.push(c.id));
    expect(seen).toEqual(visibleVideoClips(t, 900).map((v) => v.clip.id));
    expect(seen).toEqual(['a', 'b']);
  });

  it('reports the crossfade ramp-in of an overlapping pair', () => {
    const t = track([clip('a', 0, 1000), clip('b', 800, 1000)]);
    const xfades = new Map<string, number>();
    forEachVisibleVideoClip(t, 900, (c, ms) => xfades.set(c.id, ms));
    expect(xfades.get('b')).toBe(200);
    expect(xfades.get('a')).toBe(0);
  });

  it('yields nothing for a hidden track, an audio track or an empty one', () => {
    const clips = [clip('a', 0, 1000)];
    for (const t of [
      track(clips, { hidden: true }),
      track(clips, { kind: 'audio' }),
      track([]),
    ]) {
      let calls = 0;
      forEachVisibleVideoClip(t, 500, () => calls++);
      expect(calls).toBe(0);
    }
  });
});

describe('forEachUpcomingVideoClip', () => {
  const upcoming = (t: Track, tMs: number, windowMs: number): string[] => {
    const seen: string[] = [];
    forEachUpcomingVideoClip(t, tMs, windowMs, (c) => seen.push(c.id));
    return seen;
  };

  it('yields the clips starting inside the window, in start order', () => {
    const t = track([clip('a', 0, 1000), clip('b', 1000, 1000), clip('c', 2400, 500)]);
    expect(upcoming(t, 500, 1000)).toEqual(['b']);
    expect(upcoming(t, 500, 2000)).toEqual(['b', 'c']);
  });

  it('never yields a clip that already started, including the one on screen', () => {
    const t = track([clip('a', 0, 1000), clip('b', 1000, 1000)]);
    // Exactly at the cut, the incoming clip is visible, not upcoming.
    expect(upcoming(t, 1000, 1000)).toEqual([]);
  });

  it('is inclusive at the far edge of the window and stops there', () => {
    const t = track([clip('a', 0, 500), clip('b', 1000, 500), clip('c', 9000, 500)]);
    expect(upcoming(t, 0, 1000)).toEqual(['b']);
    expect(upcoming(t, 0, 999)).toEqual([]);
  });

  it('yields nothing for a hidden track, an audio track or an empty one', () => {
    const clips = [clip('a', 1000, 1000)];
    for (const t of [track(clips, { hidden: true }), track(clips, { kind: 'audio' }), track([])]) {
      expect(upcoming(t, 0, 2000)).toEqual([]);
    }
  });

  it('does not care what order the clips are stored in', () => {
    const shuffled = track([clip('c', 1500, 500), clip('a', 0, 1000), clip('b', 1000, 500)]);
    expect(upcoming(shuffled, 500, 2000)).toEqual(['b', 'c']);
  });
});

describe('maskDirtyRect', () => {
  const still = { tx: 0, ty: 0, scale: 1, rotation: 0 };
  const box: ClipMask = { shape: 'rect', x: 0.5, y: 0.5, w: 0.25, h: 0.25, feather: 0 };
  const W = 1920;
  const H = 1080;

  it('boxes a centred rect mask instead of the whole frame', () => {
    const r = maskDirtyRect(box, W, H, still);
    expect(r.x).toBeGreaterThan(700);
    expect(r.w).toBeLessThan(500);
    expect(r.h).toBeLessThan(300);
    // The saving is the point: a quarter-size mask must not cost a full frame.
    expect(r.w * r.h).toBeLessThan(W * H * 0.1);
  });

  it('contains the shape it describes, with a pixel of slack', () => {
    const r = maskDirtyRect(box, W, H, still);
    expect(r.x).toBeLessThanOrEqual(0.5 * W - 0.125 * W);
    expect(r.x + r.w).toBeGreaterThanOrEqual(0.5 * W + 0.125 * W);
    expect(r.y).toBeLessThanOrEqual(0.5 * H - 0.125 * H);
    expect(r.y + r.h).toBeGreaterThanOrEqual(0.5 * H + 0.125 * H);
  });

  it('gives up and returns the full frame for an inverted mask', () => {
    // Inverted keeps everything OUTSIDE the shape: there is nothing to clip to,
    // and claiming otherwise would erase the rest of the clip.
    expect(maskDirtyRect({ ...box, invert: true }, W, H, still)).toEqual({
      x: 0,
      y: 0,
      w: W,
      h: H,
    });
  });

  it('follows the mask when its motion translates it', () => {
    const moved = maskDirtyRect(box, W, H, { ...still, tx: 0.25 });
    const at_rest = maskDirtyRect(box, W, H, still);
    expect(moved.x - at_rest.x).toBeCloseTo(0.25 * W, 0);
  });

  it('grows with scale and with rotation', () => {
    const base = maskDirtyRect(box, W, H, still);
    expect(maskDirtyRect(box, W, H, { ...still, scale: 2 }).w).toBeGreaterThan(base.w * 1.9);
    // The mask is 480x270 px; turned 45 degrees its bounding box is
    // (480 + 270) / sqrt(2) wide. Anything narrower would clip the corners off.
    expect(maskDirtyRect(box, W, H, { ...still, rotation: 45 }).w).toBeGreaterThanOrEqual(
      (480 + 270) / Math.SQRT2,
    );
  });

  it('pads for the feather, so a soft edge is not cut off at the box', () => {
    const soft = maskDirtyRect({ ...box, feather: 0.05 }, W, H, still);
    const hard = maskDirtyRect(box, W, H, still);
    expect(soft.w).toBeGreaterThan(hard.w + 100);
  });

  it('clamps to the frame rather than describing pixels that do not exist', () => {
    const huge = maskDirtyRect({ ...box, w: 4, h: 4 }, W, H, still);
    expect(huge).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  it('boxes a pen path around its anchors and handles', () => {
    const path: ClipMask = {
      shape: 'path',
      x: 0.5,
      y: 0.5,
      w: 1,
      h: 1,
      feather: 0,
      path: [
        { x: 0.1, y: 0.1 },
        { x: 0.3, y: 0.1, in: { x: 0.2, y: 0.05 } },
        { x: 0.3, y: 0.3 },
      ],
    };
    const r = maskDirtyRect(path, W, H, still);
    expect(r.x).toBeLessThanOrEqual(0.1 * W);
    expect(r.x + r.w).toBeGreaterThanOrEqual(0.3 * W);
    // The handle at y = 0.05 sits above every anchor and must be inside the box.
    expect(r.y).toBeLessThanOrEqual(0.05 * H);
    expect(r.w * r.h).toBeLessThan(W * H * 0.2);
  });

  it('returns the full frame for a degenerate path rather than dropping the clip', () => {
    const bad: ClipMask = { shape: 'path', x: 0.5, y: 0.5, w: 1, h: 1, feather: 0, path: [] };
    expect(maskDirtyRect(bad, W, H, still)).toEqual({ x: 0, y: 0, w: W, h: H });
  });
});
