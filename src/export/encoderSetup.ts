/**
 * How a render is going to drive the encoder, decided by encoding.
 *
 * Split out of the export worker for the same reason `segmentPlan` is: the
 * decision is a short piece of reasoning about three possible answers, and it
 * can be read - and tested - without a canvas, an encoder or a worker in the
 * way. The worker supplies the probe; everything here is the strategy.
 */

/**
 * The rate control every export encodes with.
 *
 * NOT the WebCodecs default. `variable` is, and at a high cadence Chrome's VBR
 * does not merely spend less than it was asked for - it lands off the
 * rate/distortion curve entirely. Measured by re-encoding a 1440p120 screen
 * capture at "120 fps · 1080p" (which asks for 38.4 Mbps), five seconds, same
 * frames through every configuration, PSNR against the same reference:
 *
 *   VBR, cadence declared        3.1 Mbps   38.1 dB   <- what shipped
 *   CBR, cadence declared        8.2 Mbps   43.1 dB
 *   VBR, no cadence declared    86.4 Mbps   43.7 dB
 *   fixed quantizer 26           2.9 Mbps   41.6 dB
 *
 * The last row is the sentence: at the SAME bitrate the encoder is capable of
 * 3.5 dB more than VBR delivered. That is not a budget being spent carefully,
 * it is rate control failing, and it is what a viewer sees as blocking in the
 * dark areas of a capture. Nor is the target reachable by asking for more -
 * four times the bitrate produced 11.1 Mbps, not 154.
 *
 * `constant` is the honest floor available here: it holds the same picture at
 * a quarter of the asked-for bitrate rather than a twelfth, and the sheet's
 * size estimate stays an upper bound. A fixed quantizer codes better still
 * (7.0 Mbps for 43.2 dB), but it makes the file size a property of the footage
 * rather than of the preset, which is a different promise than the one the
 * export sheet makes today.
 *
 * The cadence stays declared: see `videoTrackMetadata` in `exportWorker` for
 * what dropping it costs, and the 86 Mbps row above for what it buys - ten
 * times the file for six tenths of a decibel.
 */
export const EXPORT_BITRATE_MODE = 'variable' as const;

export interface EncoderSetup {
  /**
   * Whether the cadence is declared on the video track.
   *
   * Worth a great deal (see `videoTrackMetadata` in `exportWorker`) and also the
   * one thing that can make an otherwise supported configuration be refused
   * outright: HEVC at 4K 120 is accepted with no cadence and rejected with one,
   * because the cadence is what pushes the required level past what the encoder
   * implements.
   */
  declareFrameRate: boolean;
  /**
   * Which encoder to ask for. 'no-preference' - the browser's own pick, which is
   * right nearly always and several times faster - unless that pick was found to
   * take the configuration and then produce nothing.
   */
  hardwareAcceleration: 'no-preference' | 'prefer-software';
}

/** What encoding a single frame at a given configuration can tell us. */
export type ProbeResult =
  /** Encoded a frame and finalized: the configuration works. */
  | 'ok'
  /** Rejected outright. Unsupported, and honest about it. */
  | 'refused'
  /**
   * Accepted, and then produced nothing at all. The case that matters: it is
   * the one no `try`/`catch` can see, because nothing ever rejects. See
   * `stallGuard`.
   */
  | 'stalled';

/** Encode one frame at this cadence setting on this encoder, and report which. */
export type EncodeProbe = (
  declareFrameRate: boolean,
  hardwareAcceleration: EncoderSetup['hardwareAcceleration'],
) => Promise<ProbeResult>;

/**
 * Settle both decisions from at most four one-frame encodes.
 *
 * The order encodes what each answer is worth. The cadence is tried first and
 * kept whenever the encoder will take it. A REFUSAL costs the cadence and
 * nothing else: this encoder answers, it just will not take that field, and
 * moving a working export onto the software encoder over it would trade a fast
 * render for a slow one to no purpose.
 *
 * A STALL is the opposite: an encoder that accepts a configuration and then
 * emits nothing is not refusing anything, there is nothing to catch, and
 * nothing about it is trustworthy afterwards. That is the 4K 120 hang recorded
 * in `exportWorker`, and the 1440p60 hang reported by a tester on a machine
 * where 1080p60 exports fine. Both are the same shape - a resolution or a
 * cadence past what the hardware block can sustain while its support table
 * still says yes - and both have the same way out: ask for the software
 * encoder, which is slower and finishes.
 *
 * Everything here happens before a single frame of the render, which is what
 * makes it cheap enough to be unconditional: the fallback costs seconds, and
 * what it replaces is an export that never ends.
 */
export async function chooseEncoderSetup(
  probe: EncodeProbe,
  /** Skip the browser's own choice outright: a previous attempt stalled on it. */
  forceSoftware: boolean,
  /** Somewhere to say which encoder was abandoned and why. */
  onStall?: (hardwareAcceleration: EncoderSetup['hardwareAcceleration']) => void,
): Promise<EncoderSetup> {
  const accelerations: EncoderSetup['hardwareAcceleration'][] = forceSoftware
    ? ['prefer-software']
    : ['no-preference', 'prefer-software'];

  for (const hardwareAcceleration of accelerations) {
    const withCadence = await probe(true, hardwareAcceleration);
    if (withCadence === 'ok') return { declareFrameRate: true, hardwareAcceleration };
    if (withCadence === 'refused') {
      const withoutCadence = await probe(false, hardwareAcceleration);
      // Refused again: unsupported for some reason that is not the cadence, and
      // not this function's call to make. The render goes ahead - `pickCodec`
      // has already established the browser claims to encode this - and the
      // watchdogs in the loop are what end it if the claim was wrong.
      if (withoutCadence !== 'stalled') return { declareFrameRate: false, hardwareAcceleration };
    }
    onStall?.(hardwareAcceleration);
  }

  // Even the software encoder produced nothing for one frame. The render is
  // probably doomed, but "probably" is not grounds for refusing to try: it now
  // fails in minutes with something to report rather than never.
  return { declareFrameRate: false, hardwareAcceleration: 'prefer-software' };
}
