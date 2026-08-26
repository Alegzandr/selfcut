import { useSyncExternalStore } from 'react';

/**
 * One long task that must outlive the panel it was started from.
 *
 * Transcribing, downloading a model: minutes of work started from a tab or a
 * dialog that the user is expected to leave. Held in component state, the whole
 * run went with the unmount - the progress vanished, the abort handle with it,
 * and the surface came back offering to start a second one on top of the first.
 * So the run lives out here and the UI only renders it, the way `visualJobs`
 * and `renderPreviewBus` already do.
 *
 * A slot holds ONE run at a time: `start` refuses a second rather than queueing
 * it, because everything built on this shares a scarce resource (the GPU, the
 * network) where two at once is a mistake and not a feature. Each caller keeps
 * its own slot, so a transcription and a download do not lock each other out.
 */
export interface JobSlot<T> {
  /** The running job's progress, or null when nothing is running. */
  progress: () => T | null;
  isRunning: () => boolean;
  /** Shaped for `useSyncExternalStore`. */
  subscribe: (listener: () => void) => () => void;
  /** The running job's progress, re-rendering the caller as it advances. */
  useProgress: () => T | null;
  /**
   * Run `work` as THE job of this slot, or do nothing if one is already going.
   *
   * `work` reports through the callback it is handed and must pass the signal
   * down, so cancelling from any mount of any surface reaches the worker.
   */
  start: (
    initial: T,
    work: (report: (progress: T) => void, signal: AbortSignal) => Promise<void>,
  ) => void;
  cancel: () => void;
}

export function createJobSlot<T>(name: string): JobSlot<T> {
  let job: { progress: T; abort: AbortController } | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const progress = () => job?.progress ?? null;

  return {
    progress,
    isRunning: () => job !== null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    useProgress: () =>
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        progress,
        progress,
      ),
    start: (initial, work) => {
      if (job) return;
      const abort = new AbortController();
      const mine = () => job?.abort === abort;
      job = { progress: initial, abort };
      notify();
      const report = (next: T) => {
        // Guarded on identity, not on existence: a late report from a cancelled
        // run must not paint itself over the one that replaced it.
        if (!mine()) return;
        job = { progress: next, abort };
        notify();
      };
      const finish = () => {
        if (!mine()) return;
        job = null;
        notify();
      };
      void work(report, abort.signal).then(finish, (err: unknown) => {
        finish();
        // Callers report failure to the user themselves; this only keeps a
        // rejection from going unhandled if one ever stops doing so.
        console.warn(`[${name}] job failed:`, err);
      });
    },
    cancel: () => job?.abort.abort(),
  };
}
