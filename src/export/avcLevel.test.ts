import { describe, expect, it } from 'vitest';
import { avcCodecString, avcLevelIdc, frameMacroblocks } from './avcLevel';

describe('frameMacroblocks', () => {
  it('counts 16x16 blocks, rounding partial ones up', () => {
    expect(frameMacroblocks(1920, 1080)).toBe(120 * 68);
    expect(frameMacroblocks(3840, 2160)).toBe(240 * 135);
  });
});

describe('avcLevelIdc', () => {
  it('picks the cheapest level that fits, not the strongest', () => {
    // 1080p30 at 12 Mbps is comfortably inside Level 4.0.
    expect(avcLevelIdc(1920, 1080, 30, 12_000_000)).toBe(40);
  });

  it('raises the level when only the frame rate is demanding', () => {
    // Same frame, four times the cadence: the size fits where it did, the
    // macroblock rate does not. 1080p is 8160 macroblocks, so 120 fps asks for
    // 979 k a second - past Level 5.0's 590 k, inside Level 5.1's 983 k.
    expect(avcLevelIdc(1920, 1080, 30, 12_000_000)).toBe(40);
    expect(avcLevelIdc(1920, 1080, 120, 12_000_000)).toBe(51);
  });

  it('gives 4K 120 a level whose macroblock rate can carry it', () => {
    // The case that was mislabelled: 4K fits inside Level 5.1's frame size, so
    // a size-only choice stopped there, but 4K at 120 fps is 3.89 M
    // macroblocks a second and Level 5.1 tops out at 983 k.
    expect(avcLevelIdc(3840, 2160, 120, 134_400_000)).toBe(60);
    // Same frame at 30 fps genuinely is a Level 5.1 stream.
    expect(avcLevelIdc(3840, 2160, 30, 134_400_000)).toBe(51);
  });

  it('raises the level when only the bitrate is demanding', () => {
    expect(avcLevelIdc(1280, 720, 30, 7_500_000)).toBe(31);
    expect(avcLevelIdc(1280, 720, 30, 200_000_000)).toBe(51);
  });

  it('returns the strongest defined level rather than an impossible one', () => {
    expect(avcLevelIdc(7680, 4320, 240, 2_000_000_000)).toBe(62);
  });
});

describe('avcCodecString', () => {
  it('renders High profile and the level as hex', () => {
    // 0x3C is 60, so Level 6.0.
    expect(avcCodecString(3840, 2160, 120, 134_400_000)).toBe('avc1.64003C');
    // 0x33 is 51, the string the size-only choice produced for every 4K export.
    expect(avcCodecString(3840, 2160, 30, 134_400_000)).toBe('avc1.640033');
  });
});
