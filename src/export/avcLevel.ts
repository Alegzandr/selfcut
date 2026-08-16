/**
 * Choosing the H.264 level an export actually needs.
 *
 * A level is a throughput budget, not just a size budget: it caps macroblocks
 * per second as well as macroblocks per frame. Mediabunny builds its codec
 * string from frame size and bitrate alone, which is correct until the frame
 * rate is what makes a configuration hard - and a 4K 120 fps export is exactly
 * that case. 4K fits inside Level 5.1's frame size, so the render went out
 * labelled `avc1.640033` (Level 5.1), a level whose macroblock rate only covers
 * about 30 fps at that size.
 *
 * What that mislabelling cost, measured on a real 1440p120 capture exported at
 * 4K 120: Chrome's hardware encoder accepted the configuration and produced a
 * file at 368 Mbps against the 134 Mbps it had been configured with - about 2.7
 * times the size the export sheet promises - and refused the configuration
 * outright as soon as the frame rate was declared alongside it. Neither
 * behaviour is one a user can do anything about, and the second is reported as
 * "impossible to export in 4K120".
 *
 * So the level is computed here from all three inputs and handed to mediabunny
 * as an explicit codec string.
 */

/** One row of Table A-1 of the H.264 specification. */
interface AvcLevel {
  /** `level_idc`, the byte that ends the codec string. */
  readonly idc: number;
  /** Macroblocks per second the level may decode. */
  readonly maxMacroblocksPerSecond: number;
  /** Macroblocks per frame the level may decode. */
  readonly maxFrameMacroblocks: number;
  /** Bits per second, already scaled for High profile (1.25x the base figure). */
  readonly maxBitrate: number;
}

/**
 * Ordered weakest to strongest, so the first row that fits is the cheapest one
 * that works. A player refuses a stream whose level it cannot handle, so
 * claiming more than necessary narrows where the file plays for no gain.
 */
const AVC_LEVELS: readonly AvcLevel[] = [
  { idc: 30, maxMacroblocksPerSecond: 40_500, maxFrameMacroblocks: 1_620, maxBitrate: 12_500_000 },
  { idc: 31, maxMacroblocksPerSecond: 108_000, maxFrameMacroblocks: 3_600, maxBitrate: 17_500_000 },
  { idc: 32, maxMacroblocksPerSecond: 216_000, maxFrameMacroblocks: 5_120, maxBitrate: 25_000_000 },
  { idc: 40, maxMacroblocksPerSecond: 245_760, maxFrameMacroblocks: 8_192, maxBitrate: 25_000_000 },
  { idc: 41, maxMacroblocksPerSecond: 245_760, maxFrameMacroblocks: 8_192, maxBitrate: 62_500_000 },
  { idc: 42, maxMacroblocksPerSecond: 522_240, maxFrameMacroblocks: 8_704, maxBitrate: 62_500_000 },
  { idc: 50, maxMacroblocksPerSecond: 589_824, maxFrameMacroblocks: 22_080, maxBitrate: 168_750_000 },
  { idc: 51, maxMacroblocksPerSecond: 983_040, maxFrameMacroblocks: 36_864, maxBitrate: 300_000_000 },
  { idc: 52, maxMacroblocksPerSecond: 2_073_600, maxFrameMacroblocks: 36_864, maxBitrate: 300_000_000 },
  { idc: 60, maxMacroblocksPerSecond: 4_177_920, maxFrameMacroblocks: 139_264, maxBitrate: 300_000_000 },
  { idc: 61, maxMacroblocksPerSecond: 8_355_840, maxFrameMacroblocks: 139_264, maxBitrate: 600_000_000 },
  { idc: 62, maxMacroblocksPerSecond: 16_711_680, maxFrameMacroblocks: 139_264, maxBitrate: 1_000_000_000 },
];

/** Macroblocks in one frame of the given size: 16x16 pixels each, rounded up. */
export function frameMacroblocks(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16);
}

/**
 * `level_idc` for a configuration, or the strongest level defined when nothing
 * fits (the encoder then refuses it, which is the honest outcome - a lower
 * label would only produce a file that claims to be something it is not).
 */
export function avcLevelIdc(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): number {
  const perFrame = frameMacroblocks(width, height);
  const perSecond = perFrame * Math.max(1, fps);
  const fit = AVC_LEVELS.find(
    (level) =>
      perFrame <= level.maxFrameMacroblocks &&
      perSecond <= level.maxMacroblocksPerSecond &&
      bitrate <= level.maxBitrate,
  );
  return (fit ?? AVC_LEVELS[AVC_LEVELS.length - 1]!).idc;
}

/**
 * The full H.264 codec string for a configuration: High profile, no
 * compatibility constraints, and the level above.
 */
export function avcCodecString(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): string {
  const idc = avcLevelIdc(width, height, fps, bitrate);
  return `avc1.6400${idc.toString(16).padStart(2, '0').toUpperCase()}`;
}
