/**
 * Open/closed state of the performance HUD.
 *
 * Deliberately NOT in the editor store. The HUD is the one thing in the app
 * whose job is to not perturb what it measures, and the editor store notifies
 * every subscribed selector in the application on each write. It also has
 * nothing to do with the project: closing the HUD is not an edit, does not
 * belong in the undo stack, and must not mark the project dirty.
 *
 * Opening it turns instrumentation on; closing it turns instrumentation off, so
 * a session that never opens it pays nothing at all.
 */
import { perfReset, setPerfEnabled } from './probe';

const STORAGE_KEY = 'selfcut.perfHud';

let open = readPersisted();
const listeners = new Set<() => void>();

function readPersisted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isHudOpen(): boolean {
  return open;
}

export function subscribeHud(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setHudOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  // A fresh window each time it is opened: statistics carried over from the
  // last time anyone looked would describe a different project.
  if (next) perfReset();
  setPerfEnabled(next);
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* private mode - the choice just will not persist */
  }
  for (const fn of listeners) fn();
}

export function toggleHud(): void {
  setHudOpen(!open);
}

// A HUD restored from a previous session has to arm instrumentation on boot,
// or it would render an empty panel until something toggled it.
if (open) setPerfEnabled(true);
