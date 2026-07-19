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

/**
 * Same, snapped to whole dB - what every fader does when you drag it.
 *
 * A fader is a coarse instrument: sliding through tenths makes it impossible to
 * land on a round value, and the read-out flickers over decimals nobody aimed
 * for. Whole dB gives the drag detents; decimals stay reachable through the
 * right-click entry (and Shift while dragging a clip's volume line).
 */
export function faderToGainStepped(pos: number): number {
  if (pos <= 0) return 0;
  return dbToGain(Math.round(MIN_DB + Math.min(1, pos) * (MAX_DB - MIN_DB)));
}

/**
 * Fader travel of one whole dB - the `step` of every range input, so the
 * keyboard arrows move by the same detent the pointer snaps to.
 */
export const DB_STEP_FADER = 1 / (MAX_DB - MIN_DB);

/** dB -> linear gain. At or below the bottom of the scale that is silence. */
export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : 10 ** (db / 20);
}

/** Linear gain -> dB. Silence reads as -Infinity. */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

/** Fader position of unity gain - where the "0 dB" tick is drawn. */
export const UNITY_FADER = gainToFader(1);

/**
 * Fader position -> where the clip's volume line sits, 0 at the bottom of the
 * clip and 1 at the top.
 *
 * Not the fader itself: the dB scale is lopsided (48 dB below unity, 12 above),
 * so a raw fader would rest the line at 80% of the clip height. A line that
 * idles just under the clip's top edge reads as an artefact, and it leaves no
 * room to show a boost. Each half is scaled on its own instead, which pins
 * unity dead centre - above the middle is boost, below is attenuation - and
 * hands the +12 dB of headroom half the height, where trims are finest.
 */
export function faderToLinePos(fader: number): number {
  return fader <= UNITY_FADER
    ? (fader / UNITY_FADER) * 0.5
    : 0.5 + ((fader - UNITY_FADER) / (1 - UNITY_FADER)) * 0.5;
}

/** Inverse of {@link faderToLinePos} - drags work in line positions. */
export function linePosToFader(pos: number): number {
  return pos <= 0.5
    ? (pos / 0.5) * UNITY_FADER
    : UNITY_FADER + ((pos - 0.5) / 0.5) * (1 - UNITY_FADER);
}
