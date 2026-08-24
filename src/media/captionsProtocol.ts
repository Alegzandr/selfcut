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

export type CaptionRequest =
  | {
      type: 'transcribe';
      audio: Float32Array;
      /** Model id from the catalogue (`captionsModel`), not a repo path. */
      model: string;
      /** Whisper language code (e.g. 'en', 'fr'); omit to auto-detect. */
      language?: string;
    }
  | {
      /** Fetch a model's weights without transcribing, for the model manager. */
      type: 'prefetch';
      model: string;
    };

export type CaptionReply =
  | { type: 'progress'; stage: 'model' | 'transcribe'; value: number }
  | { type: 'result'; segments: CaptionSegment[] }
  | { type: 'ready' }
  | { type: 'error'; message: string };
