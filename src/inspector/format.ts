import i18n from '../i18n';

// Slider read-outs are numbers, so they follow the locale, not the dictionary:
// "50 %" in French, "1,5 s" instead of "1.5s".
//
// One decimal, and only when the value has one: a stretch or a crop set by
// dragging in the preview is no round percentage, and printing two different
// values as the same "124 %" is what makes a clip that fits and a clip that
// still shows black bars look identical in the panel. Whole values keep reading
// as "50 %" — the digit appears when there is something to say.
export const pct = (v: number) =>
  new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(v);
/**
 * Linear gain (1 = unity) as a signed dB read-out, the unit audio people
 * actually reason in: 0.5 -> "-6.0 dB", 2 -> "+6.0 dB", silence -> "-inf dB".
 */
export const gainDb = (v: number) => {
  if (v <= 0) return '-∞ dB';
  const db = 20 * Math.log10(v);
  const n = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(db);
  return `${n} dB`;
};
export const seconds = (ms: number) =>
  new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms / 1000);

/**
 * Playback rate as the "×" read-out an editor reads a speed in: 0.5 -> "0,5×",
 * 2 -> "2×". Two decimals at most, none on a whole rate - a rate stretched by
 * dragging an edge lands on no round number, and the badge has to say which
 * side of 1× it is on to the frame.
 */
export const speedX = (v: number) =>
  `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(v)}×`;
