import { describe, expect, it } from 'vitest';
import { transitionTreatment } from './compositor';

const W = 1920;
const H = 1080;

describe('transitionTreatment', () => {
  it('dips through black: colour peaks at the midpoint, incoming appears in the second half', () => {
    expect(transitionTreatment('dipBlack', 0, W, H)).toMatchObject({
      alpha: 0,
      overlay: { color: '#000', alpha: 0 },
    });
    const mid = transitionTreatment('dipBlack', 0.5, W, H);
    expect(mid.alpha).toBe(0);
    expect(mid.overlay).toEqual({ color: '#000', alpha: 1 });
    expect(transitionTreatment('dipBlack', 1, W, H)).toMatchObject({
      alpha: 1,
      overlay: { color: '#000', alpha: 0 },
    });
  });

  it('dips through white with the same envelope', () => {
    expect(transitionTreatment('dipWhite', 0.5, W, H).overlay).toEqual({ color: '#fff', alpha: 1 });
  });

  it('slides the incoming frame in from an edge, opaque throughout', () => {
    expect(transitionTreatment('slideLeft', 0, W, H)).toMatchObject({ alpha: 1, translate: { x: W, y: 0 } });
    expect(transitionTreatment('slideLeft', 1, W, H)).toMatchObject({ alpha: 1, translate: { x: 0, y: 0 } });
    expect(transitionTreatment('slideDown', 0, W, H).translate).toEqual({ x: 0, y: -H });
  });

  it('wipes a growing reveal region', () => {
    expect(transitionTreatment('wipe', 0.5, W, H).clip).toEqual({ x: 0, y: 0, w: W / 2, h: H });
    expect(transitionTreatment('wipe', 1, W, H).clip).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  it('zooms up while fading in', () => {
    expect(transitionTreatment('zoom', 0, W, H)).toMatchObject({ alpha: 0, scale: 0.6 });
    expect(transitionTreatment('zoom', 1, W, H)).toMatchObject({ alpha: 1, scale: 1 });
  });

  it('falls back to a plain fade for dissolve', () => {
    expect(transitionTreatment('dissolve', 0.4, W, H)).toEqual({ alpha: 0.4 });
  });
});
