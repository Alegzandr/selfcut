import { describe, it, expect } from 'vitest';
import { parseCube, LutParseError } from './lut';

/** A minimal valid 2×2×2 identity 3D cube, red fastest. */
const CUBE_3D = `
# a comment
TITLE "identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('parseCube', () => {
  it('parses a 3D cube, skipping comments and header lines', () => {
    const lut = parseCube(CUBE_3D);
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(2 * 2 * 2 * 3);
    // First grid point (0,0,0) is black, last (1,1,1) is white.
    expect(lut.data.slice(0, 3)).toEqual([0, 0, 0]);
    expect(lut.data.slice(-3)).toEqual([1, 1, 1]);
  });

  it('clamps out-of-range data points into 0..1', () => {
    const lut = parseCube('LUT_3D_SIZE 2\n' + '1.5 -0.2 0.5\n'.repeat(8));
    expect(lut.data[0]).toBe(1);
    expect(lut.data[1]).toBe(0);
    expect(lut.data[2]).toBe(0.5);
  });

  it('expands a 1D cube into the equivalent separable 3D table', () => {
    // A 2-entry 1D curve: level 0 -> black, level 1 -> white on every channel.
    const lut = parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n');
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(24);
    // (r=1,g=0,b=0) -> red only; index (1 + 0 + 0)*3.
    expect(lut.data.slice(3, 6)).toEqual([1, 0, 0]);
    // (r=1,g=1,b=1) -> white; last triplet.
    expect(lut.data.slice(-3)).toEqual([1, 1, 1]);
  });

  it('rejects a file with no size declaration', () => {
    expect(() => parseCube('0 0 0\n1 1 1\n')).toThrow(LutParseError);
  });

  it('rejects a 3D cube whose data count does not match its size', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(LutParseError);
  });

  it('rejects a malformed data row', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0\n')).toThrow(LutParseError);
  });
});
