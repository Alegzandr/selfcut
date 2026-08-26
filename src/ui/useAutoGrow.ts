import { useLayoutEffect, useRef } from 'react';

/**
 * Grow a `<textarea>` to fit its own text, so it never needs the native resize
 * grip - the one that paints a diagonal in the bottom-right corner and, inside a
 * dense list, lands half under the row's border with nothing to say for itself.
 *
 * Re-measures on every value change and whenever the field is re-laid out (a
 * dragged panel edge changes how many lines the same text takes). The height is
 * set from `scrollHeight`, which only reports the content height once the
 * element's own height is out of the way, hence the reset to `auto` first.
 */
export function useAutoGrow<T extends HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // Observing the field itself would loop (we resize it); its parent gives
    // the same width signal without feeding back.
    const parent = el.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [value]);

  return ref;
}
