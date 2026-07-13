/** Tiny vibration when a drag snaps into place (no-op where unsupported, e.g. iOS Safari). */
export function snapTick() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // ignore
  }
}
