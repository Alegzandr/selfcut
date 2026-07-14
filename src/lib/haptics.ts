/** Tiny vibration when a drag snaps into place (no-op where unsupported, e.g. iOS Safari). */
export function snapTick() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // ignore
  }
}

/** Drag state that remembers the last position a haptic tick fired for. */
export interface SnapHapticState {
  lastSnap: number | null;
}

/**
 * Fire exactly one haptic tick each time a drag newly snaps to a point: compare
 * the snapped value against the raw (un-snapped) one and against the last
 * position we ticked for. Returns the snapped value for convenient chaining.
 */
export function hapticOnSnap(raw: number, snapped: number, state: SnapHapticState): number {
  if (snapped !== raw && state.lastSnap !== snapped) snapTick();
  state.lastSnap = snapped !== raw ? snapped : null;
  return snapped;
}
