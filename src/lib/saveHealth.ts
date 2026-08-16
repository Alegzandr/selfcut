/**
 * Whether local persistence is actually working.
 *
 * A save can fail for reasons that do not go away by themselves: the origin's
 * storage quota is full, IndexedDB is blocked in a private window, the user
 * cleared site data mid-session. Reporting that once per session - as a toast
 * that scrolls away in four seconds - tells the user their work is not being
 * saved at the exact moment they are least able to act on it, and then never
 * mentions it again while they keep editing for an hour.
 *
 * So failure is a STATE, not an event. It stays visible until a save succeeds,
 * and a new failure after a recovery notifies again rather than being swallowed
 * by a session-wide latch.
 *
 * The reducer is pure and takes its own clock, so the policy is unit-tested
 * without a database, a timer or a store.
 */

export interface SaveHealth {
  /** True while the last attempt failed and nothing has succeeded since. */
  failing: boolean;
  /** Failures in the current streak; 0 once a save succeeds. */
  failures: number;
  /** Timestamp of the last successful write, 0 if nothing has been saved yet. */
  lastSavedAt: number;
  /** Timestamp of the first failure of the current streak, 0 when healthy. */
  failingSince: number;
  /**
   * True on the transition INTO a failing state - the one moment worth a toast.
   * Subsequent failures of the same streak leave it false, so a save retried
   * every few seconds does not spam.
   */
  justFailed: boolean;
}

export const HEALTHY: SaveHealth = {
  failing: false,
  failures: 0,
  lastSavedAt: 0,
  failingSince: 0,
  justFailed: false,
};

export type SaveEvent = 'ok' | 'failed';

/** The state machine. Pure: same inputs, same output, no clock of its own. */
export function nextSaveHealth(state: SaveHealth, event: SaveEvent, now: number): SaveHealth {
  if (event === 'ok') {
    return { failing: false, failures: 0, lastSavedAt: now, failingSince: 0, justFailed: false };
  }
  return {
    failing: true,
    failures: state.failures + 1,
    lastSavedAt: state.lastSavedAt,
    failingSince: state.failing ? state.failingSince : now,
    justFailed: !state.failing,
  };
}

let current: SaveHealth = HEALTHY;
const listeners = new Set<() => void>();

export function getSaveHealth(): SaveHealth {
  return current;
}

/**
 * Subscribe to changes. Shaped for `useSyncExternalStore`, so the banner reads
 * this directly instead of the editor store - a save outcome has nothing to do
 * with the project, and pushing it through the store would wake every selector
 * in the app on a background write.
 */
export function subscribeSaveHealth(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function commit(next: SaveHealth): void {
  // Identity is the change signal for useSyncExternalStore, so an unchanged
  // outcome must not produce a new object.
  if (
    next.failing === current.failing &&
    next.failures === current.failures &&
    next.lastSavedAt === current.lastSavedAt
  ) {
    return;
  }
  current = next;
  for (const fn of listeners) fn();
}

export function reportSaveOk(now = Date.now()): void {
  commit(nextSaveHealth(current, 'ok', now));
}

/** Records a failure and answers whether this is the one worth surfacing. */
export function reportSaveFailed(now = Date.now()): boolean {
  const next = nextSaveHealth(current, 'failed', now);
  const announce = next.justFailed;
  commit(next);
  return announce;
}

/** Test seam: back to a clean slate. */
export function resetSaveHealth(): void {
  current = HEALTHY;
  for (const fn of listeners) fn();
}
