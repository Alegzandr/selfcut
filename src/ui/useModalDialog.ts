import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Shared behaviour of the editor's modal dialogs: focus moves in on open and
 * back out on close, Tab stays inside, and Escape reaches the topmost dialog
 * only.
 *
 * The stack is what makes the last part work. Dialogs open on top of each
 * other (Preferences ▸ Reset data, Project library ▸ Confirm), and a listener
 * per dialog on `window` cannot express "only the one in front":
 * `stopPropagation` does not stop the other listeners on the same target, so a
 * single Escape used to close the whole pile.
 */
interface ModalEntry {
  panel: RefObject<HTMLElement | null>;
  /** Read at keystroke time, so it always sees the dialog's current state. */
  escape: RefObject<(() => void) | undefined>;
}

const stack: ModalEntry[] = [];

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab stops inside `panel`, minus whatever is not rendered (a hidden tab panel). */
function tabStops(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

function onKeyDown(e: KeyboardEvent) {
  const top = stack.at(-1);
  if (!top) return;

  if (e.key === 'Escape') {
    const escape = top.escape.current;
    // No handler: the dialog's dismissal is owned by the editor hotkeys (the
    // shortcuts panel), so the key has to reach them.
    if (!escape) return;
    // Immediate: dialogs outside this stack (the export sheet) still listen on
    // window themselves, and this listener is registered before any of them.
    e.stopImmediatePropagation();
    escape();
    return;
  }

  if (e.key !== 'Tab') return;
  const panel = top.panel.current;
  if (!panel) return;
  const stops = tabStops(panel);
  const first = stops.at(0);
  const last = stops.at(-1);
  if (!first || !last) {
    // Nothing focusable left inside: keep the caret rather than let Tab walk
    // out into the editor sitting behind the overlay.
    e.preventDefault();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && panel.contains(active);
  const leaving = !inside || (e.shiftKey ? active === first || active === panel : active === last);
  if (!leaving) return;
  e.preventDefault();
  (e.shiftKey ? last : first).focus();
}

// Installed once at import, capture phase: ahead of the editor hotkeys and of
// every per-component window listener, which all register later from effects.
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeyDown, { capture: true });
}

/**
 * True while a dialog that owns its Escape is open. The editor hotkeys go
 * inert then: a stray Space or Delete must not edit behind the overlay.
 */
export function modalDialogOpen(): boolean {
  return stack.some((entry) => entry.escape.current);
}

/**
 * Make `panelRef` behave as a modal dialog while `open`.
 *
 * `onEscape` is called when Escape is pressed and this dialog is the topmost
 * one; leave it out only when something else owns the dismissal. A dialog that
 * must not close right now (an erase in flight) passes a handler that does
 * nothing: the key is still consumed, so the dialog behind it stays put too.
 *
 * Focus goes to `initialFocus` when given, else to the first tab stop inside
 * the panel, and is handed back to whatever held it before on close.
 */
export function useModalDialog(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  options: {
    onEscape?: () => void;
    initialFocus?: RefObject<HTMLElement | null>;
  } = {},
): void {
  const escape = useRef(options.onEscape);
  // Kept current after every render, so Escape sees the dialog's latest state
  // (a rename in progress, an erase in flight) without re-registering.
  useLayoutEffect(() => {
    escape.current = options.onEscape;
  });
  const initialFocus = options.initialFocus;

  useEffect(() => {
    if (!open) return;
    const entry: ModalEntry = { panel: panelRef, escape };
    stack.push(entry);

    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const target = initialFocus?.current ?? (panel ? tabStops(panel).at(0) : undefined) ?? panel;
    target?.focus({ preventScroll: true });

    return () => {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      // `isConnected`: a dialog opened from a menu outlives the item that
      // opened it, and focusing a detached node silently drops focus on body.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, panelRef, initialFocus]);
}
