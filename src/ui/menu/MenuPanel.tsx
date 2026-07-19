import { useEffect, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Close a popover on Escape or on a pointer press outside of it. Bound to the
 * window rather than to a blur handler so a press anywhere - including on the
 * canvas or another panel - dismisses it, and so a press on the trigger itself
 * reaches the trigger's own toggle.
 */
export function useDismissOnOutside(
  open: boolean,
  close: () => void,
  rootRef: { current: HTMLElement | null },
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
    // `close` and `rootRef` are stable for every caller; re-binding on each
    // render would tear down the listeners mid-press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * The chrome of a dropdown panel: border, blurred background, shadow, and the
 * open/close motion. Positioning stays with the caller, since only it knows
 * which edge the panel has room to grow from.
 *
 * `from` is the side the panel is anchored to, so it slides *out* of its
 * trigger: a panel below drops down, a panel above rises.
 */
export function MenuPanel({
  className = '',
  from = 'top',
  children,
}: {
  className?: string;
  from?: 'top' | 'bottom';
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const offset = from === 'top' ? -4 : 4;
  return (
    <motion.div
      role="menu"
      className={`absolute z-40 max-w-[calc(100vw-1rem)] rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl shadow-black/50 backdrop-blur ${className}`}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: offset }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
