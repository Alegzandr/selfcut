/**
 * How the currently focused element got its focus: pointer or keyboard.
 *
 * `:focus-visible` cannot answer this from inside a keydown handler. Per spec,
 * a keypress is itself an expression of keyboard intent, so the browser flips
 * the focused element to `:focus-visible` *before* dispatching the key - by the
 * time a handler asks, a button the user merely clicked already matches. That
 * made Space activate the last-clicked button instead of driving playback.
 *
 * So we record the modality at the moment focus moves, which is the moment that
 * actually carries the answer, and read it back later.
 */

let hadKeyboardEvent = false;
let focusFromKeyboard = false;

if (typeof window !== 'undefined') {
  // Modifier-only presses (Ctrl before Ctrl+click, a held Shift) are not
  // keyboard *navigation* - they routinely precede a pointer gesture.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      hadKeyboardEvent = true;
    },
    { capture: true },
  );
  for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
    window.addEventListener(type, () => (hadKeyboardEvent = false), { capture: true });
  }
  // Capture phase: this must land before any component's own focus handling.
  window.addEventListener('focusin', () => (focusFromKeyboard = hadKeyboardEvent), {
    capture: true,
  });
}

/**
 * True when the focused element was reached with the keyboard (Tab, or a
 * key-driven focus move) rather than by clicking or tapping it.
 */
export function focusIsKeyboardDriven(): boolean {
  return focusFromKeyboard;
}
