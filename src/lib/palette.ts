/**
 * The palette values the app needs outside of CSS.
 *
 * Canvas fills, SVG `stroke` attributes and the DOM-driven level meter cannot
 * take a utility class, so they need the literal colour. They are spelled here
 * once rather than at each call site: the editor reads as sky/amber/emerald/red
 * everywhere else, and a hand-typed `#fbbf24` three files away is exactly how
 * that vocabulary drifts apart.
 *
 * The keys mirror Tailwind's own names so a value can be checked against the
 * class used for the same semantic in neighbouring markup.
 */
const TW = {
  sky300: '#7dd3fc',
  sky400: '#38bdf8',
  amber400: '#fbbf24',
  emerald300: '#6ee7b7',
  emerald400: '#34d399',
  red400: '#f87171',
  zinc700: '#3f3f46',
  zinc900: '#18181b',
  zinc950: '#09090b',
} as const;

/**
 * `#rrggbb` at a given alpha, as the `#rrggbbaa` form that canvas, CSS and SVG
 * presentation attributes all parse.
 */
function alpha(hex: string, a: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, a)) * 255);
  return hex + byte.toString(16).padStart(2, '0');
}

/** Timeline clip decorations drawn as SVG rather than as utility classes. */
export const CLIP_COLORS = {
  /** Fade in/out ramp line: amber, the same hue as the fade handles. */
  fadeRamp: alpha(TW.amber400, 0.95),
  /** Crossfade ramp line: sky, matching the overlap window's tint. */
  crossfadeRamp: alpha(TW.sky300, 0.9),
  /** Waveform inside an audio clip, over its emerald body. */
  audioWaveform: alpha(TW.emerald300, 0.65),
} as const;

/**
 * Level meter bands. Same three semantics the rest of the app spells with
 * `text-red-400` / `text-amber-400` / `text-emerald-400`.
 */
export const METER_COLORS = {
  /** Above -3 dBFS: close enough to clipping to warn about. */
  hot: TW.red400,
  /** -12 to -3 dBFS: loud but safe. */
  warm: TW.amber400,
  /** Below -12 dBFS: comfortable. */
  normal: TW.emerald400,
} as const;

/** Preview-stage colours, painted onto the canvas. */
export const PREVIEW_COLORS = {
  /** Fill of a freshly drawn shape. */
  shapeFill: TW.sky400,
  /** Stroke that keeps a light cursor legible over bright footage. */
  cursorOutline: TW.zinc900,
  /** Scrim dimming everything outside the crop rectangle. */
  cropScrim: alpha(TW.zinc950, 0.6),
} as const;

/**
 * Colour filling the preview panel around the output frame - the letterbox.
 *
 * Deliberately *not* black. The engine paints the frame itself `#000`, so a near
 * black surround makes a clip's own letterbox bars indistinguishable from the
 * panel behind them: a 2.39:1 source in a 16:9 project would look full-frame.
 * Zinc-700 is far enough off black to read the frame edge at a glance while
 * staying dark enough not to skew how the footage itself looks.
 */
export const DEFAULT_PREVIEW_BACKGROUND = TW.zinc700;

/** Named surrounds offered in Preferences, alongside a free colour picker. */
export const PREVIEW_BACKGROUNDS = {
  /** True black: matches the frame fill, for judging blacks without a reference. */
  black: '#000000',
  /** The app chassis' own shade, for a preview that melts into the layout. */
  charcoal: TW.zinc950,
  /** The default: clearly off black, still dark. */
  grey: DEFAULT_PREVIEW_BACKGROUND,
  /** Neutral mid grey, the reference surround for judging exposure. */
  neutral: '#808080',
  /** Maximum contrast against dark footage, for spotting frame edges. */
  white: '#ffffff',
} as const;
