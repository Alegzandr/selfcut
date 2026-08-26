import { createJobSlot } from '../lib/backgroundJob';
import { prefetchCaptionModel } from './captions';

/** Which model is downloading, and how far along, 0..1. */
export interface ModelDownload {
  id: string;
  value: number;
}

/**
 * The one Whisper model download that can be in flight.
 *
 * It used to be killed the moment its dialog closed, on the grounds that a
 * several-hundred-megabyte fetch with nowhere to show progress should not be
 * left running. The conclusion was right and the fix was backwards: a download
 * this long is exactly the thing someone starts and then goes back to cutting
 * over, and throwing it away on close means it can only ever be done by sitting
 * and watching it. So it keeps running, and the model manager picks the same
 * run back up whenever it is reopened - the surface it lives on, no more
 * hidden than the file it is writing into the browser's cache.
 */
const slot = createJobSlot<ModelDownload>('caption-model');

export const captionModelDownload = slot.progress;
export const isCaptionModelDownloading = slot.isRunning;
export const useCaptionModelDownload = slot.useProgress;
export const cancelCaptionModelDownload = slot.cancel;

/**
 * Fetch `id`'s weights in the background. `onDone` runs when the download ends
 * whatever it ends as, so the caller can re-read what is now cached.
 */
export function startCaptionModelDownload(id: string, onDone: () => void): void {
  slot.start({ id, value: 0 }, async (report, signal) => {
    try {
      await prefetchCaptionModel(id, (value) => report({ id, value }), signal);
    } catch (err) {
      console.warn('[captions] model download failed:', err);
    } finally {
      onDone();
    }
  });
}
