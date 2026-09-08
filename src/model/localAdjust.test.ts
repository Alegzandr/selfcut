import { describe, it, expect } from 'vitest';
import type { ClipLocalAdjust } from '../types';
import { LOCAL_ADJUST_PROPS, activeLocalAdjusts, defaultLocalAdjust, resolveLocalAdjustColor } from './localAdjust';

/**
 * What a masked grade resolves to.
 *
 * Two claims carry the feature. A region applies the parameters it is supposed
 * to and drops the two that are not measured inside a shape - otherwise a
 * vignette control would draw the frame's corners inside a face. And a region
 * that comes to nothing resolves to null, because the renderer spends a full
 * WebGL pass on anything that does not.
 */

function region(color: ClipLocalAdjust['color']): ClipLocalAdjust {
  return { ...defaultLocalAdjust(), id: 'r1', color };
}

describe('resolveLocalAdjustColor', () => {
  it('applies the parameters a region is measured in', () => {
    const r = resolveLocalAdjustColor(region({ brightness: 0.2, saturation: -0.5, sharpen: 0.4 }), 0);
    expect(r).toMatchObject({ brightness: 0.2, saturation: -0.5, sharpen: 0.4 });
  });

  it('drops the vignette, which is measured from the frame and not from the shape', () => {
    expect(resolveLocalAdjustColor(region({ vignette: 1 }), 0)).toBeNull();
    const mixed = resolveLocalAdjustColor(region({ vignette: 1, contrast: 0.3 }), 0);
    expect(mixed).toMatchObject({ contrast: 0.3, vignette: 0 });
  });

  it('drops the blur, which is what a redaction already is', () => {
    expect(resolveLocalAdjustColor(region({ blur: 0.8 }), 0)).toBeNull();
  });

  it('carries a LUT and a curve through, since a colour map means the same on a region', () => {
    const r = resolveLocalAdjustColor(region({ lut: { id: 'l1', intensity: 0.5 } }), 0);
    expect(r?.lut).toEqual({ id: 'l1', intensity: 0.5 });
  });

  it('is null for an empty region, so a freshly added one costs no pass', () => {
    expect(resolveLocalAdjustColor(region({}), 0)).toBeNull();
    expect(resolveLocalAdjustColor(region({ brightness: 0 }), 0)).toBeNull();
  });

  it('samples keyframed parameters at the clip-local time it is asked for', () => {
    const animated = region({
      brightness: [
        { t: 0, value: 0 },
        { t: 1000, value: 1 },
      ],
    });
    expect(resolveLocalAdjustColor(animated, 0)).toBeNull();
    expect(resolveLocalAdjustColor(animated, 1000)?.brightness).toBe(1);
    // Mid-ramp: the value moved, which is the whole point of keyframing it.
    const mid = resolveLocalAdjustColor(animated, 500)?.brightness ?? 0;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('LOCAL_ADJUST_PROPS', () => {
  it('leaves out exactly the two parameters a shape cannot measure', () => {
    expect(LOCAL_ADJUST_PROPS).not.toContain('vignette');
    expect(LOCAL_ADJUST_PROPS).not.toContain('blur');
    expect(LOCAL_ADJUST_PROPS).toContain('sharpen');
  });
});

describe('activeLocalAdjusts', () => {
  it('is null for no regions and for an all-muted list, so the clip skips the scratch', () => {
    expect(activeLocalAdjusts(undefined)).toBeNull();
    expect(activeLocalAdjusts([])).toBeNull();
    expect(activeLocalAdjusts([{ ...region({ brightness: 1 }), disabled: true }])).toBeNull();
  });

  it('keeps the enabled regions in list order', () => {
    const a = { ...region({ brightness: 1 }), id: 'a' };
    const b = { ...region({ contrast: 1 }), id: 'b', disabled: true };
    const c = { ...region({ tint: 1 }), id: 'c' };
    expect(activeLocalAdjusts([a, b, c])?.map((r) => r.id)).toEqual(['a', 'c']);
  });
});
