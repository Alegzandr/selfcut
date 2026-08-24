/**
 * Per-frame budgets for the render loop's pure logic.
 *
 * These are regression tests, not a profiler. They are written as RATIOS
 * against the implementation each optimization replaced, or against a hard
 * structural bound, because an absolute millisecond threshold means nothing on
 * a shared CI runner - it either passes on every machine and catches nothing,
 * or it is tuned to one laptop and fails on the next.
 *
 * What they defend: nothing in the per-frame path may go back to scanning the
 * whole project, and nothing may go back to allocating per frame.
 *
 * Run by `npm run bench`, which the CI gate calls on every branch.
 */
import { describe, expect, it } from 'vitest';
import { clipsAt, maskDirtyRect } from '../preview/compositor';
import { trackCrossfades } from '../model';
import { resolveOverlaps } from '../store/projectOps';
import { Rolling } from './probe';
import type { Clip, ClipMask, MediaClip } from '../types';

function clip(id: string, startMs: number, durMs: number): MediaClip {
  return {
    kind: 'media',
    id,
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: durMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
}

/** A dense cut: `n` clips, each 4 s, butted end to end with a 0.5 s overlap. */
function timeline(n: number): Clip[] {
  const clips: Clip[] = [];
  for (let i = 0; i < n; i++) clips.push(clip(`c${i}`, i * 3500, 4000));
  return clips;
}

/** The linear scan + sort the indexed lookup replaced. */
function linearClipsAt(clips: Clip[], tMs: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const dur = (c.sourceOutMs - c.sourceInMs) / c.speed;
    if (tMs >= c.timelineStartMs && tMs < c.timelineStartMs + dur) out.push(c);
  }
  return out.sort((a, b) => a.timelineStartMs - b.timelineStartMs);
}

/**
 * A pass shorter than this cannot be told apart from the noise around it: a
 * scheduler slice on a shared runner is itself about a millisecond.
 */
const MIN_PASS_MS = 5;

/**
 * The fastest of several measured passes, each repeated until it is long
 * enough to measure.
 *
 * Interference on a shared runner - a GC pause, a scheduler slice, a noisy
 * neighbour - only ever ADDS time to a pass, so the minimum of several is the
 * closest available estimate of what the code itself costs. But the minimum
 * only helps when a clean pass exists to be found, and some of the things
 * measured here are far too fast for that: one pass of the indexed lookup
 * takes about a tenth of a millisecond, so a single stall lands on EVERY rep
 * and inflated the measured cost seven-fold on CI - enough to fail a ratio
 * that holds by 12x when it is measured cleanly. So the pass is batched up to
 * `MIN_PASS_MS` first, which puts the stall back in proportion, and the result
 * is divided back down to the cost of one pass.
 */
function time(fn: () => void, reps = 7): number {
  // One warm pass so the comparison is between two optimized functions, not
  // between an optimized one and one the JIT has never seen.
  fn();
  let batch = 1;
  // 1024 is a backstop for a `fn` too cheap to ever reach the floor; nothing
  // measured here comes close to needing it.
  while (batch < 1024) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) fn();
    if (performance.now() - t0 >= MIN_PASS_MS) break;
    batch *= 2;
  }
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    for (let j = 0; j < batch; j++) fn();
    best = Math.min(best, (performance.now() - t0) / batch);
  }
  return best;
}

describe('visible-clip lookup', () => {
  const CLIPS = 300;
  const FRAMES = 3600; // one minute at 60 fps
  const clips = timeline(CLIPS);
  const span = CLIPS * 3500;

  it('does not grow with the number of clips on the track', () => {
    // The whole point of the index: a 300-clip track and a 20-clip track cost
    // the same per frame. Measured as work per frame so the two runs compare.
    const perFrame = (n: number): number => {
      const t = timeline(n);
      const len = n * 3500;
      return (
        time(() => {
          for (let i = 0; i < FRAMES; i++) clipsAt(t, (i / FRAMES) * len);
        }) / FRAMES
      );
    };
    const small = perFrame(20);
    const large = perFrame(600);
    // Thirty times the clips, and the budget must not even double. A linear
    // scan would be thirty times slower here.
    expect(large).toBeLessThan(Math.max(small * 2, 0.002));
  });

  it('beats the linear scan it replaced by a wide margin', () => {
    const indexed = time(() => {
      for (let i = 0; i < FRAMES; i++) clipsAt(clips, (i / FRAMES) * span);
    });
    const linear = time(() => {
      for (let i = 0; i < FRAMES; i++) linearClipsAt(clips, (i / FRAMES) * span);
    });
    expect(indexed).toBeLessThan(linear / 3);
  });

  it('answers a frame in well under a sixtieth of the frame budget', () => {
    // A 16.6 ms frame has many other things to do. Deciding which clips are on
    // screen must be free at the resolution the loop cares about: budget the
    // whole per-frame lookup for a 300-clip track at 1% of one frame.
    const perFrame =
      time(() => {
        for (let i = 0; i < FRAMES; i++) clipsAt(clips, (i / FRAMES) * span);
      }) / FRAMES;
    expect(perFrame).toBeLessThan(16.6 / 100);
  });

  it('reuses the crossfade map across frames instead of rebuilding it', () => {
    // Identity, not equality: a fresh Map per frame per track is the regression.
    expect(trackCrossfades(clips)).toBe(trackCrossfades(clips));
  });

  it('rebuilds when copy-on-write hands it a new array', () => {
    const edited = [...clips];
    expect(trackCrossfades(edited)).not.toBe(trackCrossfades(clips));
  });
});

describe('mask region', () => {
  const W = 3840;
  const H = 2160;
  const still = { tx: 0, ty: 0, scale: 1, rotation: 0 };

  it('shrinks a typical mask to a fraction of the frame', () => {
    // A quarter-frame mask used to cost a full-frame clear, a full-frame draw,
    // a full-frame matte composite and a full-frame copy back, four times over.
    const mask: ClipMask = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.3, h: 0.4, feather: 0.01 };
    const r = maskDirtyRect(mask, W, H, still);
    expect((r.w * r.h) / (W * H)).toBeLessThan(0.2);
  });

  it('costs nothing to compute, whatever the path complexity', () => {
    const path: ClipMask = {
      shape: 'path',
      x: 0.5,
      y: 0.5,
      w: 1,
      h: 1,
      feather: 0,
      path: Array.from({ length: 200 }, (_, i) => ({
        x: 0.5 + 0.2 * Math.cos((i / 200) * Math.PI * 2),
        y: 0.5 + 0.2 * Math.sin((i / 200) * Math.PI * 2),
      })),
    };
    const perCall = time(() => {
      for (let i = 0; i < 10000; i++) maskDirtyRect(path, W, H, still);
    }) / 10000;
    expect(perCall).toBeLessThan(0.05);
  });
});

describe('instrumentation overhead', () => {
  it('records a sample in constant time and constant space', () => {
    const r = new Rolling();
    const perPush =
      time(() => {
        for (let i = 0; i < 200000; i++) r.push(i);
      }) / 200000;
    // If recording a frame time cost more than a microsecond, the probe would
    // be measuring itself.
    expect(perPush).toBeLessThan(0.001);
  });
});

describe('edit latency', () => {
  /** A project of `tracks` tracks, each holding `perTrack` butted clips. */
  function project(tracks: number, perTrack: number) {
    return {
      id: 'p',
      name: 'p',
      fps: 60,
      aspectRatio: '16:9' as const,
      markers: [],
      tracks: Array.from({ length: tracks }, (_track, t) => ({
        id: `t${t}`,
        kind: 'video' as const,
        clips: Array.from({ length: perTrack }, (_clip, i) => ({
          ...clip(`t${t}c${i}`, i * 4000, 4000),
          trackId: `t${t}`,
        })),
      })),
    };
  }

  it('settles a large project fast enough to run on every pointermove', () => {
    // Every committed edit calls this, including each move of a drag - which
    // fires at pointer rate. A 1000-clip project has to settle in well under a
    // frame or dragging a clip in a long cut stutters.
    const big = project(4, 250);
    const perCall =
      time(() => {
        for (let i = 0; i < 200; i++) resolveOverlaps(big, null);
      }) / 200;
    expect(perCall).toBeLessThan(16.6 / 4);
  });

  it('returns the SAME project when nothing had to move', () => {
    // The identity is what keeps copy-on-write working: a new Project object
    // for a no-op edit would invalidate every memo in the application.
    const big = project(2, 200);
    expect(resolveOverlaps(big, null)).toBe(big);
  });

  it('returns the same tracks it did not touch', () => {
    const p = project(3, 50);
    // Overlap two clips on the first track only.
    const clashing = {
      ...p,
      tracks: p.tracks.map((t, i) =>
        i === 0
          ? { ...t, clips: t.clips.map((c, j) => (j === 5 ? { ...c, timelineStartMs: 4000 } : c)) }
          : t,
      ),
    };
    const settled = resolveOverlaps(clashing, null);
    expect(settled).not.toBe(clashing);
    expect(settled.tracks[1]).toBe(clashing.tracks[1]);
    expect(settled.tracks[2]).toBe(clashing.tracks[2]);
  });
});
