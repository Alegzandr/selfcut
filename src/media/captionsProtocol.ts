/**
 * Message protocol between the main thread and the captions worker. The audio is
 * a mono 16 kHz Float32 buffer (transferred, not copied); the worker replies with
 * model-download progress and then the transcribed segments.
 */

/** One transcribed span, in seconds relative to the audio start. `endSec` can be
 * null on the trailing chunk, which the caller resolves against the next start. */
export interface CaptionSegment {
  startSec: number;
  endSec: number | null;
  text: string;
}

/**
 * Whether this is a phone or a tablet, which decides the precision the weights
 * are fetched and loaded at (see `CaptionModelInfo.handheld`).
 *
 * Sent rather than probed: the signal is `matchMedia('(pointer: coarse)')`,
 * which exists on the window and not in a worker. Left to the worker to answer
 * it would say "desktop" on every phone and download the fp32 weights that
 * crash the tab.
 */
interface HandheldFlag {
  handheld: boolean;
}

export type CaptionRequest =
  | (HandheldFlag & {
      type: 'transcribe';
      audio: Float32Array;
      /** Model id from the catalogue (`captionsModel`), not a repo path. */
      model: string;
      /** Whisper language code (e.g. 'en', 'fr'); omit to auto-detect. */
      language?: string;
    })
  | (HandheldFlag & {
      /** Fetch a model's weights without transcribing, for the model manager. */
      type: 'prefetch';
      model: string;
    });

export type CaptionReply =
  | { type: 'progress'; stage: 'model'; value: number }
  /** How far into the audio the decoder is, 0..1 - null when it cannot be placed. */
  | { type: 'progress'; stage: 'transcribe'; value: number | null }
  | { type: 'result'; segments: CaptionSegment[] }
  | { type: 'ready' }
  | {
      type: 'error';
      message: string;
      /**
       * Set when the browser refused to store the weights (quota, private
       * mode). Carried as a code because an Error's class does not survive
       * `postMessage`, and this is the one failure with its own advice.
       */
      code?: 'storage';
    };
