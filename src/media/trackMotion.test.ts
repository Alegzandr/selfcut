import { describe, expect, it } from 'vitest';
import { extractPatch, searchPatch, trackFrames, type GrayFrame } from './trackMotion';

const W = 120;
const H = 90;
const CX = 60;
const CY = 45;

/** A smooth, non-periodic analytic texture — good gradients for patch matching. */
function tex(x: number, y: number): number {
  return 128 + 60 * Math.sin(x * 0.3) + 50 * Math.cos(y * 0.37) + 40 * Math.sin((x + y) * 0.21);
}

/** Build a `W×H` grayscale frame by sampling `at(x, y)` on the integer grid. */
function frame(at: (x: number, y: number) => number): GrayFrame {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = at(x, y);
  return { data, w: W, h: H };
}

const OPTS = { half: 8, radius: 12 };

describe('extractPatch / searchPatch', () => {
  it('finds a patch translated by a known offset', () => {
    const f0 = frame(tex);
    const f1 = frame((x, y) => tex(x - 5, y + 3)); // shift right 5, up -3
    const ref = extractPatch(f0, CX, CY, OPTS.half);
    const found = searchPatch(f1, ref, OPTS.half, CX, CY, OPTS.radius);
    expect(found.x).toBe(CX + 5);
    expect(found.y).toBe(CY - 3);
  });
});

describe('trackFrames', () => {
  const p1 = { x: CX - 18, y: CY };
  const p2 = { x: CX + 18, y: CY };

  it('recovers a pure translation', () => {
    const frames = [frame(tex), frame((x, y) => tex(x - 6, y - 4))];
    const m = trackFrames(frames, p1, p2, OPTS);
    expect(m.tx[1]).toBeCloseTo(6 / W, 2);
    expect(m.ty[1]).toBeCloseTo(4 / H, 2);
    expect(m.scale[1]).toBeCloseTo(1, 2);
    expect(Math.abs(m.rotation[1]!)).toBeLessThan(1);
    // The first frame is always the identity.
    expect(m.tx[0]).toBe(0);
    expect(m.scale[0]).toBe(1);
  });

  it('recovers a zoom as a scale ratio', () => {
    const s = 1.15;
    const scaled = frame((x, y) => tex(CX + (x - CX) / s, CY + (y - CY) / s));
    const m = trackFrames([frame(tex), scaled], p1, p2, OPTS);
    expect(m.scale[1]).toBeGreaterThan(1.08);
    expect(m.scale[1]).toBeLessThan(1.22);
    expect(Math.abs(m.tx[1]!)).toBeLessThan(0.03);
  });

  it('recovers a rotation in degrees', () => {
    const th = (6 * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    // frame1(x,y) samples the source rotated by -theta about the centre, so a
    // feature ends up rotated by +theta.
    const rot = frame((x, y) => {
      const rx = x - CX;
      const ry = y - CY;
      return tex(CX + rx * cos + ry * sin, CY - rx * sin + ry * cos);
    });
    const m = trackFrames([frame(tex), rot], p1, p2, OPTS);
    expect(m.rotation[1]).toBeGreaterThan(3);
    expect(m.rotation[1]).toBeLessThan(9);
  });
});
