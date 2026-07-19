/**
 * Audio gain scale, shared by every volume control (track fader, clip fader,
 * clip volume line).
 *
 * Gains are stored linearly (1 = unity) but every control is laid out in dB,
 * the way a real fader works: the useful range around unity gets most of the
 * travel instead of being squeezed into the top of a linear 0..2 slider.
 *
 * The bottom of the travel is silence (-inf dB), not MIN_DB - same as the
 * Vegas fader. The jump from MIN_DB to silence is inaudible.
 */

export const MIN_DB = -48;
export const MAX_DB = 12;

/** Loudest gain any control can reach: +12 dB. */
export const MAX_GAIN = 10 ** (MAX_DB / 20);

/** Linear gain -> fader position in 0..1. Silence sits at 0. */
export function gainToFader(gain: number): number {
  if (gain <= 0) return 0;
  const db = 20 * Math.log10(gain);
  if (db <= MIN_DB) return 0;
  return Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB));
}

/** Fader position in 0..1 -> linear gain. 0 is silence, not MIN_DB. */
export function faderToGain(pos: number): number {
  if (pos <= 0) return 0;
  // Quantized to 0.1 dB so the stored gain always matches the read-out.
  const db = Math.round((MIN_DB + Math.min(1, pos) * (MAX_DB - MIN_DB)) * 10) / 10;
  return 10 ** (db / 20);
}

/** Fader position of unity gain - where the "0 dB" tick is drawn. */
export const UNITY_FADER = gainToFader(1);
