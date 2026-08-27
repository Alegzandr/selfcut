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
      // Said out loud, because the failure is otherwise invisible: the bar just
      // stops and the next transcription starts the same download again. The
      // one worth naming apart is storage - on a phone it means "make room",
      // and nothing about retrying will help until it is made.
      // Imported here rather than at the top, as `mediaCache` does: the store
      // reaches back into this module through the surfaces that start the job.
      const [{ useStore }, { t }] = await Promise.all([
        import('../store/store'),
        import('../i18n'),
      ]);
      useStore
        .getState()
        .setError(
          t(
            err instanceof Error && err.name === 'CaptionStorageError'
              ? 'errors.captions.storage'
              : 'errors.captions.download',
          ),
        );
    } finally {
      onDone();
    }
  });
}
