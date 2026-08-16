import { describe, expect, it } from 'vitest';
import {
  BT2020_LUMA,
  BT601_LUMA,
  BT709_LUMA,
  isHighBitDepth,
  lumaWeightsFor,
  transferKindFor,
} from './frameSource';

describe('lumaWeightsFor', () => {
  it('honours a declared matrix over the frame size', () => {
    expect(lumaWeightsFor('bt709', 480)).toBe(BT709_LUMA);
    expect(lumaWeightsFor('smpte170m', 2160)).toBe(BT601_LUMA);
    expect(lumaWeightsFor('bt2020-ncl', 1080)).toBe(BT2020_LUMA);
  });

  it('falls back to BT.709 for HD when the container declares nothing', () => {
    // The bug this replaces: a fixed BT.601 matrix on 1080p footage, which
    // skews every desaturation and every waveform reading.
    expect(lumaWeightsFor(null, 1080)).toBe(BT709_LUMA);
    expect(lumaWeightsFor(undefined, 2160)).toBe(BT709_LUMA);
    expect(lumaWeightsFor(null, 577)).toBe(BT709_LUMA);
  });

  it('falls back to BT.601 for standard definition', () => {
    expect(lumaWeightsFor(null, 576)).toBe(BT601_LUMA);
    expect(lumaWeightsFor(null, 480)).toBe(BT601_LUMA);
  });

  it('treats a zero or unknown height as HD rather than SD', () => {
    expect(lumaWeightsFor(null, 0)).toBe(BT709_LUMA);
  });

  it('keeps every weight set normalized to 1', () => {
    for (const w of [BT601_LUMA, BT709_LUMA, BT2020_LUMA]) {
      expect(w.r + w.g + w.b).toBeCloseTo(1, 4);
    }
  });
});

describe('transferKindFor', () => {
  it('maps the HDR transfers to themselves', () => {
    expect(transferKindFor('pq')).toBe('pq');
    expect(transferKindFor('hlg')).toBe('hlg');
    expect(transferKindFor('linear')).toBe('linear');
  });

  it('treats everything else, including nothing at all, as sRGB-like', () => {
    expect(transferKindFor('iec61966-2-1')).toBe('srgb');
    expect(transferKindFor('bt709')).toBe('srgb');
    expect(transferKindFor(null)).toBe('srgb');
    expect(transferKindFor(undefined)).toBe('srgb');
  });
});

describe('isHighBitDepth', () => {
  it('is true for the 10- and 12-bit pixel formats', () => {
    expect(isHighBitDepth('I420P10', 'srgb')).toBe(true);
    expect(isHighBitDepth('I422P12', 'srgb')).toBe(true);
    expect(isHighBitDepth('I444AP10', 'srgb')).toBe(true);
  });

  it('is true for an HDR transfer whatever the declared format', () => {
    expect(isHighBitDepth(null, 'pq')).toBe(true);
    expect(isHighBitDepth('I420', 'hlg')).toBe(true);
  });

  it('is false for ordinary 8-bit footage, so it never doubles texture memory', () => {
    expect(isHighBitDepth('I420', 'srgb')).toBe(false);
    expect(isHighBitDepth('NV12', 'srgb')).toBe(false);
    expect(isHighBitDepth('RGBA', 'srgb')).toBe(false);
    expect(isHighBitDepth(null, 'srgb')).toBe(false);
  });
});
