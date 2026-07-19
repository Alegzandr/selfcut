import i18n from '../i18n';

// Slider read-outs are numbers, so they follow the locale, not the dictionary:
// "50 %" in French, "1,5 s" instead of "1.5s".
export const pct = (v: number) =>
  new Intl.NumberFormat(i18n.language, { style: 'percent' }).format(v);
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
