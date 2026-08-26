import { createJobSlot } from '../lib/backgroundJob';
import type { CaptionProgress } from './captions';

/**
 * The one caption run that can be in flight, and how far along it is.
 *
 * Transcribing takes minutes, and the panel it is started from is a tab: the
 * moment someone looks at the clip inspector the generator unmounts. So the run
 * lives in a slot outside React (see `backgroundJob`), and both the panel and
 * the inspector's tab strip read it - which is what lets the user leave, keep
 * cutting, and come back to a run still in progress instead of to a button that
 * would start it all over again.
 */
const slot = createJobSlot<CaptionProgress>('captions');

export const captionJobProgress = slot.progress;
export const isCaptionJobRunning = slot.isRunning;
export const subscribeCaptionJob = slot.subscribe;
export const useCaptionJob = slot.useProgress;
export const cancelCaptionJob = slot.cancel;

/** Run `work` as the caption job, or do nothing if one is already running. */
export function startCaptionJob(
  work: (
    report: (progress: CaptionProgress) => void,
    signal: AbortSignal,
  ) => Promise<void>,
): void {
  // Every run opens on the model stage: the weights are loaded (or fetched)
  // before a single sample is transcribed.
  slot.start({ stage: 'model', value: 0 }, work);
}
