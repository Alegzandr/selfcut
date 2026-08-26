import { describe, expect, it } from 'vitest';
import {
  cancelCaptionJob,
  captionJobProgress,
  isCaptionJobRunning,
  startCaptionJob,
  subscribeCaptionJob,
} from './captionJob';

/** A job whose completion the test controls. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('captionJob', () => {
  it('refuses a second run while one is in flight', async () => {
    const first = deferred();
    let starts = 0;
    const work = (d: { promise: Promise<void> }) => () => {
      starts++;
      return d.promise;
    };
    startCaptionJob(work(first));
    startCaptionJob(work(deferred()));
    expect(starts).toBe(1);
    expect(isCaptionJobRunning()).toBe(true);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(isCaptionJobRunning()).toBe(false);
  });

  it('keeps reporting progress to subscribers, then clears', async () => {
    const done = deferred();
    const seen: Array<number | null> = [];
    const unsubscribe = subscribeCaptionJob(() =>
      seen.push(captionJobProgress()?.value ?? null),
    );
    startCaptionJob((report) => {
      report({ stage: 'transcribe', value: 0.5 });
      return done.promise;
    });
    expect(captionJobProgress()).toEqual({ stage: 'transcribe', value: 0.5 });

    done.resolve();
    await done.promise;
    await Promise.resolve();
    expect(captionJobProgress()).toBeNull();
    // Start, the 0.5 report, and the clear.
    expect(seen).toEqual([0, 0.5, null]);
    unsubscribe();
  });

  it('cancels through the signal the work was handed', async () => {
    const done = deferred();
    let aborted = false;
    startCaptionJob((_report, signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        done.resolve();
      });
      return done.promise;
    });
    cancelCaptionJob();
    await done.promise;
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(isCaptionJobRunning()).toBe(false);
  });

  it('ignores a late report from a run that has ended', async () => {
    const done = deferred();
    let late!: (p: { stage: 'transcribe'; value: number }) => void;
    startCaptionJob((report) => {
      late = report;
      return done.promise;
    });
    done.resolve();
    await done.promise;
    await Promise.resolve();
    late({ stage: 'transcribe', value: 0.9 });
    expect(captionJobProgress()).toBeNull();
  });
});
