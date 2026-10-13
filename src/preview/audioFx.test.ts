import { describe, expect, it } from 'vitest';
import { fillReverbImpulse } from './audioFx';

describe('fillReverbImpulse', () => {
  const ir = (channel: number) => {
    const data = new Float32Array(4800);
    fillReverbImpulse(data, channel);
    return data;
  };

  it('is the same impulse every time it is built', () => {
    // Rebuilt per audio context: the preview's and every export slice's must match.
    expect(ir(0)).toEqual(ir(0));
    expect(ir(1)).toEqual(ir(1));
  });

  it('decorrelates the two channels', () => {
    expect(ir(0)).not.toEqual(ir(1));
  });

  it('is decaying noise within [-1, 1]', () => {
    const data = ir(0);
    expect(data.every((v) => v >= -1 && v <= 1)).toBe(true);
    const energy = (from: number, to: number) =>
      data.slice(from, to).reduce((sum, v) => sum + v * v, 0);
    expect(energy(0, 1200)).toBeGreaterThan(energy(3600, 4800) * 10);
  });
});
