import type { ColorProp } from '../types';

/**
 * Slider range of each colour parameter, in the order `COLOR_PROPS` lists them.
 *
 * One table, shared by the clip's Adjust section and the track FX pane: the two
 * grade through the same WebGL pass, so a parameter that runs -1..1 on a clip
 * and 0..1 on a lane would be the same knob meaning two things.
 */
export const COLOR_RANGES: Record<ColorProp, { min: number; max: number }> = {
  brightness: { min: -1, max: 1 },
  contrast: { min: -1, max: 1 },
  saturation: { min: -1, max: 1 },
  temperature: { min: -1, max: 1 },
  tint: { min: -1, max: 1 },
  vignette: { min: 0, max: 1 },
  blur: { min: 0, max: 1 },
  sharpen: { min: 0, max: 1 },
};

/** How a graded parameter reads: signed points either side of 0, or a percentage. */
export function formatColorValue(min: number, v: number): string {
  return min < 0 ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}` : `${Math.round(v * 100)}%`;
}
