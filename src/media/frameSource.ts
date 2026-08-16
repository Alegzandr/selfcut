/**
 * What a decoded frame can tell the renderer about itself.
 *
 * `DrawableFrame` is deliberately the smallest interface the 2D compositor
 * needs (`draw`), which is all a Canvas 2D path ever wanted. The GPU path wants
 * two more things, and neither can be a method on the interface because the
 * concrete types come from mediabunny and cannot grow one:
 *
 *  - a **direct texture source**, so a frame reaches the GPU without being
 *    rasterized into an intermediate 8-bit canvas first (one full-frame copy
 *    and one quantization removed per graded clip per frame);
 *  - its **colour space**, so the grade uses the luma coefficients and transfer
 *    function the footage was actually encoded with instead of assuming.
 *
 * Both are read by duck-typing here, in one place, rather than sprinkling
 * `'toCanvasImageSource' in sample` through the render loop.
 */
import { StillFrame, type DrawableFrame } from './stillImage';

/** The mediabunny surface this module reads, without importing its class. */
interface SampleLike {
  toCanvasImageSource?: () => OffscreenCanvas | VideoFrame;
  rotation?: number;
  format?: string | null;
  colorSpace?: {
    primaries?: string | null;
    transfer?: string | null;
    matrix?: string | null;
    fullRange?: boolean | null;
  } | null;
}

/**
 * The frame as something WebGL can sample directly, or null when it must go
 * through the 2D rasterization path.
 *
 * A sample carrying rotation metadata returns null on purpose:
 * `toCanvasImageSource` hands back the UNROTATED surface (only `draw` applies
 * the rotation), so uploading it directly would silently render footage from a
 * phone sideways. Correctness first; those clips keep the copy.
 */
export function frameTexSource(sample: DrawableFrame): TexImageSource | null {
  if (sample instanceof StillFrame) {
    return sample.bitmap.width === 0 ? null : sample.bitmap;
  }
  const s = sample as unknown as SampleLike;
  if (typeof s.toCanvasImageSource !== 'function') return null;
  if (s.rotation) return null;
  try {
    return s.toCanvasImageSource();
  } catch {
    return null;
  }
}

/** Luma coefficients (Kr, Kg, Kb) for a set of matrix coefficients. */
export interface LumaWeights {
  r: number;
  g: number;
  b: number;
}

export const BT709_LUMA: LumaWeights = { r: 0.2126, g: 0.7152, b: 0.0722 };
export const BT601_LUMA: LumaWeights = { r: 0.299, g: 0.587, b: 0.114 };
export const BT2020_LUMA: LumaWeights = { r: 0.2627, g: 0.678, b: 0.0593 };

/**
 * Which luma coefficients a frame's own metadata calls for.
 *
 * When the container declares its matrix, that is the answer. When it does not -
 * common in phone recordings and in anything remuxed by a careless tool - the
 * frame height decides, which is the same heuristic every decoder applies:
 * 576 lines or fewer is standard definition (BT.601), anything taller is HD or
 * better (BT.709). Guessing BT.601 for a 1080p frame, as a fixed 0.299/0.587/
 * 0.114 does, shifts every desaturation and every waveform reading.
 */
export function lumaWeightsFor(matrix: string | null | undefined, height: number): LumaWeights {
  switch (matrix) {
    case 'bt709':
      return BT709_LUMA;
    case 'smpte170m':
      return BT601_LUMA;
    case 'bt2020-ncl':
      return BT2020_LUMA;
    default:
      return height > 0 && height <= 576 ? BT601_LUMA : BT709_LUMA;
  }
}

/**
 * How a frame's code values map to light. `'srgb'` covers sRGB and BT.709/601
 * footage alike: their opto-electronic transfer functions differ only in the
 * toe, far below what any grading control can resolve, and treating them as one
 * keeps a single inverse in the shader. PQ and HLG are reported as themselves
 * so the caller can refuse to pretend they are SDR.
 */
export type TransferKind = 'srgb' | 'pq' | 'hlg' | 'linear';

export function transferKindFor(transfer: string | null | undefined): TransferKind {
  switch (transfer) {
    case 'pq':
      return 'pq';
    case 'hlg':
      return 'hlg';
    case 'linear':
      return 'linear';
    default:
      return 'srgb';
  }
}

/**
 * Whether a frame carries more than 8 bits per component - the P10 and P12
 * pixel formats, or an HDR transfer, which is never authored at 8 bits. Those
 * are the only frames worth uploading into a half-float texture: for ordinary
 * 8-bit footage it would double the texture memory to store zeroes.
 */
export function isHighBitDepth(format: string | null | undefined, transfer: TransferKind): boolean {
  if (transfer === 'pq' || transfer === 'hlg') return true;
  return !!format && /P1[02]$/.test(format);
}

/** Colour description of a frame, with the fallbacks already applied. */
export interface FrameColorSpace {
  luma: LumaWeights;
  transfer: TransferKind;
  highBitDepth: boolean;
}

export function frameColorSpace(sample: DrawableFrame): FrameColorSpace {
  const s = sample as unknown as SampleLike;
  const cs = s.colorSpace ?? null;
  const transfer = transferKindFor(cs?.transfer);
  return {
    luma: lumaWeightsFor(cs?.matrix, sample.displayHeight),
    transfer,
    highBitDepth: isHighBitDepth(s.format, transfer),
  };
}
