/**
 * Which background passes over a source are running right now.
 *
 * A clip's waveform and filmstrip are not part of the import: the file lands on
 * the timeline immediately and its visuals are filled in behind it (see
 * `ensureAssetVisuals`). On short footage that is invisible. On the hour-long
 * recordings this editor is for, reading the whole audio track for its envelope
 * takes seconds, and the clip sits there flat and empty with nothing saying
 * that anything is happening.
 *
 * This is what lets the clip say it. Deliberately a registry of RUNNING jobs
 * rather than an inference from "there are no peaks yet": a pass that fails, or
 * that finds nothing to read, ends here too, so the indicator always stops.
 * Inferring it from the absence of data is what leaves a spinner turning for
 * ever on the one file it could not read.
 *
 * Module-level rather than store state: it is derived, never persisted, never
 * undone, and reaches the UI through `useSyncExternalStore` like the other
 * out-of-band signals (`renderPreviewBus`, `meterBus`).
 */

/** Key -> how many passes are running for it (see `trackVisualJob`). */
const active = new Map<string, number>();
const listeners = new Set<() => void>();

/** Key for the waveform pass over one audio track of one asset. */
export function peaksJobKey(assetId: string, audioTrackIndex: number): string {
  return `${assetId}#peaks#${audioTrackIndex}`;
}

/** Key for the thumbnail pass over one asset. */
export function thumbnailsJobKey(assetId: string): string {
  return `${assetId}#thumbnails`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Run `work` with `key` marked active, whatever it resolves to and however it
 * fails. The result is passed through untouched - callers keep their own
 * handling of an empty or failed pass.
 */
export function trackVisualJob<T>(key: string, work: Promise<T>): Promise<T> {
  // Counted rather than flagged: two callers can ask for the same pass (a
  // project reopened while the first read is still running), and the first one
  // to finish must not clear an indicator the other is still earning.
  const running = active.get(key) ?? 0;
  active.set(key, running + 1);
  if (running === 0) notify();
  const done = () => {
    const left = (active.get(key) ?? 1) - 1;
    if (left > 0) {
      active.set(key, left);
      return;
    }
    active.delete(key);
    notify();
  };
  return work.then(
    (value) => {
      done();
      return value;
    },
    (err: unknown) => {
      done();
      throw err;
    },
  );
}

export function isVisualJobActive(key: string): boolean {
  return active.has(key);
}

export function subscribeVisualJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop every recorded job. */
export function resetVisualJobs(): void {
  if (active.size === 0) return;
  active.clear();
  notify();
}
