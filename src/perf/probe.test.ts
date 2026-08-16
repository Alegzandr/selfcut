import { describe, expect, it, beforeEach } from 'vitest';
import {
  PERF_WINDOW,
  Rolling,
  count,
  endFrame,
  endSpan,
  perfEnabled,
  perfReset,
  record,
  setPerfEnabled,
  setPerfFrameBudget,
  snapshot,
  span,
  subscribePerf,
} from './probe';

describe('Rolling', () => {
  it('summarizes an empty window as zeroes rather than NaN', () => {
    const s = new Rolling().stats('x');
    expect(s).toEqual({ name: 'x', last: 0, mean: 0, p95: 0, max: 0, n: 0 });
  });

  it('reports mean, max and last over the samples it holds', () => {
    const r = new Rolling();
    for (const v of [1, 2, 3, 4]) r.push(v);
    const s = r.stats('t');
    expect(s.n).toBe(4);
    expect(s.mean).toBe(2.5);
    expect(s.max).toBe(4);
    expect(s.last).toBe(4);
  });

  it('keeps only the last PERF_WINDOW samples', () => {
    const r = new Rolling();
    // Fill with 0, then overwrite the whole window with 5: nothing of the first
    // pass may survive, or the window is not actually bounded.
    for (let i = 0; i < PERF_WINDOW; i++) r.push(0);
    for (let i = 0; i < PERF_WINDOW; i++) r.push(5);
    const s = r.stats('t');
    expect(s.n).toBe(PERF_WINDOW);
    expect(s.mean).toBe(5);
  });

  it('puts p95 at the top of the distribution, not near the mean', () => {
    const r = new Rolling();
    // 94 cheap frames and 6 stutters: nearest-rank p95 over 100 samples reads
    // the 95th value, which must land in the stutters.
    for (let i = 0; i < 100; i++) r.push(i < 94 ? 1 : 50);
    const s = r.stats('t');
    expect(s.p95).toBe(50);
    expect(s.mean).toBeLessThan(4.5);
  });

  it('never allocates a ring larger than the window', () => {
    const r = new Rolling();
    for (let i = 0; i < PERF_WINDOW * 3; i++) r.push(i);
    expect(r.n).toBe(PERF_WINDOW);
    expect(r.last).toBe(PERF_WINDOW * 3 - 1);
  });
});

describe('probe', () => {
  beforeEach(() => {
    setPerfEnabled(false);
    perfReset();
  });

  it('is off by default and records nothing', () => {
    expect(perfEnabled()).toBe(false);
    const t = span();
    endSpan('x', t);
    count('c');
    endFrame();
    expect(snapshot().timings).toHaveLength(0);
    expect(snapshot().frames).toBe(0);
  });

  it('returns a sentinel span when off, so endSpan cannot record a bogus value', () => {
    expect(span()).toBe(-1);
    setPerfEnabled(true);
    expect(span()).toBeGreaterThan(0);
  });

  it('rolls per-frame accumulators into channels on endFrame', () => {
    setPerfEnabled(true);
    record('draw', 4);
    record('draw', 2);
    count('clips', 3);
    endFrame();
    const snap = snapshot();
    expect(snap.frames).toBe(1);
    expect(snap.timings.find((t) => t.name === 'draw')?.last).toBe(6);
    expect(snap.counters.find((c) => c.name === 'clips')?.last).toBe(3);
  });

  it('samples a channel as zero on frames that never touch it', () => {
    setPerfEnabled(true);
    record('mask', 10);
    endFrame();
    endFrame();
    endFrame();
    endFrame();
    const mask = snapshot().timings.find((t) => t.name === 'mask')!;
    expect(mask.n).toBe(4);
    expect(mask.mean).toBe(2.5);
    expect(mask.last).toBe(0);
  });

  it('counts frames over the budget', () => {
    setPerfEnabled(true);
    setPerfFrameBudget(10);
    record('frame', 5);
    endFrame();
    record('frame', 25);
    endFrame();
    const snap = snapshot();
    expect(snap.frames).toBe(2);
    expect(snap.overBudget).toBe(1);
    expect(snap.frameBudgetMs).toBe(10);
  });

  it('sorts timings by mean so the dominant cost is first', () => {
    setPerfEnabled(true);
    record('cheap', 1);
    record('expensive', 30);
    endFrame();
    expect(snapshot().timings[0]!.name).toBe('expensive');
  });

  it('does not turn recording on just because something subscribed', () => {
    let seen = 0;
    const off = subscribePerf(() => {
      seen++;
    });
    record('draw', 5);
    endFrame();
    expect(perfEnabled()).toBe(false);
    expect(seen).toBe(0);
    off();
  });

  it('drops everything on reset', () => {
    setPerfEnabled(true);
    record('draw', 5);
    endFrame();
    perfReset();
    const snap = snapshot();
    expect(snap.frames).toBe(0);
    expect(snap.timings).toHaveLength(0);
  });
});
