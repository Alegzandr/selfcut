/**
 * How many decimals a slider's numeric field is seeded with when it opens.
 *
 * Kept apart from `SliderRow` because the rule is arithmetic, not UI: a field
 * that seeds fewer decimals than the value actually holds rewrites that value
 * the moment it is committed, and the row has no way to notice.
 */

/**
 * Ceiling on seeded decimals. Past this a read-out stops being something a
 * human retypes, and the residual error is far below one output pixel.
 */
export const MAX_ENTRY_DECIMALS = 4;

/** Float slack: `1.2437 * 100` is `124.37000000000001`, and that still counts. */
const ROUND_TRIP_EPSILON = 1e-9;

/**
 * Decimals a typed value needs to be as fine as the slider itself: one step
 * expressed in the entry's own unit. A 0.01 step read as a percentage is a whole
 * point (0 decimals); a 100 ms step read as seconds is a tenth (1 decimal).
 */
export function decimalsForStep(
  toInput: (v: number) => number,
  value: number,
  step: number,
): number {
  // Slack on the thresholds: a 0.01 step scaled by 100 lands on 0.99999999 as
  // often as on 1, and that must not seed a whole percentage as "70.0".
  const stepIn = Math.abs(toInput(value + step) - toInput(value));
  if (!isFinite(stepIn) || stepIn > 0.999) return 0;
  if (stepIn > 0.0999) return 1;
  return 2;
}

/**
 * Decimals that let the field round-trip the value it was seeded with, using
 * `floor` (what one slider step needs) as the minimum.
 *
 * The step is a floor rather than the answer because the slider is not the only
 * thing that writes these properties: a stretch dragged on the preview lands on
 * any real number, so a 123,7 % stretch seeded as "124" turns into exactly 124 %
 * as soon as the field is committed — which is how the black bars a 4:3 clip was
 * stretched out of come back. Opening a field and pressing Enter must be a no-op.
 */
export function seedDecimals(input: number, floor: number): number {
  if (!isFinite(input)) return floor;
  for (let d = floor; d < MAX_ENTRY_DECIMALS; d++) {
    if (Math.abs(Number(input.toFixed(d)) - input) < ROUND_TRIP_EPSILON) return d;
  }
  return MAX_ENTRY_DECIMALS;
}
