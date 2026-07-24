/**
 * Pure analysis for the video scopes — the waveform monitor, RGB parade,
 * histogram and vectorscope a colourist reads instead of trusting the eye.
 *
 * These turn a downsampled RGBA preview frame into the intensity grids the
 * scopes panel paints; there is no DOM here, so the maths is unit tested and the
 * component owns only the drawing. BT.601 luma is used throughout — the same
 * weights the colour pass uses for saturation — so the waveform's luma trace
 * agrees with what the grade actually does to the picture.
 */

/** The scope the monitor shows, or 'off' when the panel is closed. */
export type ScopeMode = 'off' | 'waveform' | 'parade' | 'histogram' | 'vectorscope';

/** Selectable scopes, in the order the picker lists them. */
export const SCOPE_MODES: readonly ScopeMode[] = [
  'waveform',
  'parade',
  'histogram',
  'vectorscope',
];

/** 8-bit code range: every scope quantises to these 256 levels. */
export const SCOPE_LEVELS = 256;

/**
 * Width the engine downsamples the composited frame to before publishing it.
 * Enough columns for a legible waveform, few enough pixels (≈256×144 for 16:9)
 * that the per-frame read-back and analysis stay cheap.
 */
export const SCOPE_SAMPLE_WIDTH = 256;

/** BT.601 luma of an 8-bit RGB triple, as a 0..255 code value. */
export function luma601(r: number, g: number, b: number): number {
  return (r * 0.299 + g * 0.587 + b * 0.114) | 0;
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  /** Largest single-bin count across the R, G and B channels, for normalisation. */
  peak: number;
}

/**
 * Per-channel tonal distribution: how many pixels of the frame fall on each of
 * the 256 code levels, for R, G, B and luma. `peak` excludes luma so a flat
 * grey frame (whose luma spike would dwarf every colour bin) still shows its
 * channels at a readable height.
 */
export function computeHistogram(data: Uint8ClampedArray): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const rr = data[i]!;
    const gg = data[i + 1]!;
    const bb = data[i + 2]!;
    r[rr]!++;
    g[gg]!++;
    b[bb]!++;
    luma[luma601(rr, gg, bb)]!++;
  }
  let peak = 1;
  for (let i = 0; i < 256; i++) {
    if (r[i]! > peak) peak = r[i]!;
    if (g[i]! > peak) peak = g[i]!;
    if (b[i]! > peak) peak = b[i]!;
  }
  return { r, g, b, luma, peak };
}

/** Which signal a waveform column histogram is built over. */
export type ScopeChannel = 'luma' | 'r' | 'g' | 'b';

/**
 * Waveform column histogram: for each column x of the frame, how many pixels sit
 * on each of the 256 code levels of `channel`. Row-major, `width * SCOPE_LEVELS`
 * entries, indexed `x * SCOPE_LEVELS + level`.
 *
 * This is the raw waveform-monitor data: the panel maps level 255 to the top of
 * the graticule and level 0 to the bottom, painting a column brighter where more
 * pixels of that column share a level — so a flat sky reads as a tight bright
 * band and a noisy gradient as a soft smear.
 */
export function computeWaveform(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  channel: ScopeChannel,
): Uint32Array {
  const grid = new Uint32Array(width * SCOPE_LEVELS);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * 4;
      const rr = data[i]!;
      const gg = data[i + 1]!;
      const bb = data[i + 2]!;
      const v =
        channel === 'luma'
          ? luma601(rr, gg, bb)
          : channel === 'r'
            ? rr
            : channel === 'g'
              ? gg
              : bb;
      grid[x * SCOPE_LEVELS + v]!++;
    }
  }
  return grid;
}

/**
 * Vectorscope density: the BT.601 chroma (Cb, Cr) of every pixel binned onto a
 * `size × size` grid centred on neutral grey, counting how many pixels land in
 * each cell. Cb runs to the right and Cr up the screen — the broadcast
 * convention — so a well-balanced skin tone clusters along the usual diagonal
 * "I" line and an oversaturated grade pushes points toward the rim.
 *
 * Chroma is scaled by `size` (not `size/2`): full-saturation primaries at 8-bit
 * reach roughly ±0.44, so the plot fills the box without the extremes clipping
 * against its edge.
 */
export function computeVectorscope(data: Uint8ClampedArray, size: number): Uint32Array {
  const grid = new Uint32Array(size * size);
  const half = size / 2;
  for (let i = 0; i < data.length; i += 4) {
    const rr = data[i]! / 255;
    const gg = data[i + 1]! / 255;
    const bb = data[i + 2]! / 255;
    const y = rr * 0.299 + gg * 0.587 + bb * 0.114;
    const cb = (bb - y) / 1.772; // -0.5..0.5
    const cr = (rr - y) / 1.402;
    const px = (half + cb * size) | 0;
    const py = (half - cr * size) | 0;
    if (px >= 0 && px < size && py >= 0 && py < size) grid[py * size + px]!++;
  }
  return grid;
}
