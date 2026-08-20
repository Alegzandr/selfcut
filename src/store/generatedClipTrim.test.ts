import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { ClipShape } from '../types';

/**
 * Trimming a generated clip (shape, solid, text): it renders itself, so there
 * is no source to run out of and BOTH edges stretch without bound. Store
 * bootstrapped like imageAssets.test.ts (node environment, stubbed DOM bits).
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown; structuredClone: typeof structuredClone };
  g.document ??= { documentElement: {} };
  g.structuredClone = (<T>(v: T): T => JSON.parse(JSON.stringify(v)) as T) as typeof structuredClone;
  ({ useStore } = await import('./store'));
});

const rect: ClipShape = { kind: 'rect', w: 0.3, h: 0.2, fill: '#fff', strokeWidth: 0, radius: 0, sides: 5 };

const s = () => useStore.getState();
const onlyClip = () => s().project.tracks.flatMap((t) => t.clips)[0]!;

beforeEach(() => {
  s().resetProject();
  s().addShapeClip(rect, { x: 0.5, y: 0.5 });
  // Parked at 5s so the left edge has room to travel outward.
  s().moveClip(onlyClip().id, 5000);
});

describe('trimming a generated clip', () => {
  it('starts as a 3s clip', () => {
    const clip = onlyClip();
    expect(clip.kind).toBe('shape');
    expect(clip.timelineStartMs).toBe(5000);
    expect(clip.sourceOutMs - clip.sourceInMs).toBe(3000);
  });

  it('stretches to the right without bound', () => {
    s().trimClip(onlyClip().id, 'right', 20_000);
    const clip = onlyClip();
    expect(clip.timelineStartMs).toBe(5000);
    expect(clip.sourceOutMs - clip.sourceInMs).toBe(15_000);
  });

  it('stretches to the left too: the edge lengthens the clip', () => {
    s().trimClip(onlyClip().id, 'left', 1000);
    const clip = onlyClip();
    expect(clip.timelineStartMs).toBe(1000);
    expect(clip.sourceInMs).toBe(0);
    // The right edge stayed at 8000.
    expect(clip.sourceOutMs - clip.sourceInMs).toBe(7000);
  });

  it('never runs past t=0 nor past its own right edge', () => {
    const id = onlyClip().id;
    s().trimClip(id, 'left', -4000);
    expect(onlyClip().timelineStartMs).toBe(0);
    expect(onlyClip().sourceOutMs - onlyClip().sourceInMs).toBe(8000);
    s().trimClip(id, 'left', 20_000);
    expect(onlyClip().sourceOutMs - onlyClip().sourceInMs).toBeGreaterThan(0);
    expect(onlyClip().timelineStartMs).toBeLessThan(8000);
  });

  it('shrinks from the left like any other clip', () => {
    s().trimClip(onlyClip().id, 'left', 6000);
    const clip = onlyClip();
    expect(clip.timelineStartMs).toBe(6000);
    expect(clip.sourceInMs).toBe(1000);
    expect(clip.sourceOutMs - clip.sourceInMs).toBe(2000);
  });
});
