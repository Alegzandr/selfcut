import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { FocusEvent, PointerEvent, ReactElement, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useIsCoarsePointer } from '../lib/device';

type Placement = 'top' | 'bottom';

interface TooltipProps {
  /** The hint text. When it is a string it also becomes the trigger's aria-label. */
  label: ReactNode;
  /** Optional accelerator rendered as a <kbd> chip, e.g. "Ctrl+E". */
  shortcut?: string;
  /** Preferred side; flips automatically when it would clip the viewport. */
  placement?: Placement;
  /** Hover dwell before the tip appears (keyboard focus shows it instantly). */
  delay?: number;
  disabled?: boolean;
  /** A single interactive element (button/input/div). */
  children: ReactElement;
}

const GAP = 8; // distance between trigger and tip
const EDGE = 6; // min gap from the viewport edge

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object') (ref as { current: T }).current = node;
    }
  };
}

function chain<E>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) {
  return (e: E) => {
    theirs?.(e);
    ours(e);
  };
}

/**
 * Styled, portal-based replacement for the native `title` attribute.
 *
 * Wraps a single trigger element (cloned, so no extra DOM is inserted and the
 * dense toolbar layouts stay pixel-identical). Shows on hover after a short
 * dwell and instantly on keyboard focus; suppressed on touch, where the native
 * title never fired either. When `label` is a string it doubles as the
 * trigger's `aria-label`, so icon-only buttons keep their accessible name.
 */
export function Tooltip({
  label,
  shortcut,
  placement = 'top',
  delay = 350,
  disabled,
  children,
}: TooltipProps) {
  const coarse = useIsCoarsePointer();
  const reduce = useReducedMotion();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; place: Placement }>({
    left: 0,
    top: 0,
    place: placement,
  });

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const tip = tipRef.current;
    const tipH = tip?.offsetHeight ?? 30;
    const tipW = tip?.offsetWidth ?? 0;

    let place = placement;
    if (place === 'top' && r.top < tipH + GAP + EDGE) place = 'bottom';
    else if (place === 'bottom' && r.bottom + tipH + GAP + EDGE > window.innerHeight) place = 'top';

    const top = place === 'top' ? r.top - GAP : r.bottom + GAP;
    const half = tipW / 2;
    const center = r.left + r.width / 2;
    const left = half
      ? Math.min(Math.max(center, half + EDGE), window.innerWidth - half - EDGE)
      : center;
    setPos({ left, top, place });
  }, [placement]);

  const show = () => {
    if (disabled || coarse || label == null) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      measure();
      setOpen(true);
    }, delay);
  };

  const showInstant = () => {
    if (disabled || coarse || label == null) return;
    window.clearTimeout(timer.current);
    measure();
    setOpen(true);
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Re-measure once mounted (now that the tip has a real size to center/clamp on)
  // and keep it pinned to the trigger while scrolling or resizing.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    const sync = () => measure();
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [open, measure]);

  if (!isValidElement(children)) return children;

  const child = children as ReactElement<Record<string, unknown>>;
  const props = child.props;
  const hasLabel = props['aria-label'] != null || props['aria-labelledby'] != null;

  const trigger = cloneElement(child, {
    ref: mergeRefs(triggerRef, (props as { ref?: Ref<HTMLElement> }).ref),
    onMouseEnter: chain(props.onMouseEnter as ((e: unknown) => void) | undefined, show),
    onMouseLeave: chain(props.onMouseLeave as ((e: unknown) => void) | undefined, hide),
    onPointerDown: chain(props.onPointerDown as ((e: PointerEvent) => void) | undefined, hide),
    onFocus: chain(props.onFocus as ((e: FocusEvent) => void) | undefined, (e: FocusEvent) => {
      // Only surface on keyboard focus, not the focus a mouse click leaves behind.
      if (e.target instanceof Element && e.target.matches(':focus-visible')) showInstant();
    }),
    onBlur: chain(props.onBlur as ((e: FocusEvent) => void) | undefined, hide),
    ...(!hasLabel && typeof label === 'string' ? { 'aria-label': label } : {}),
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={tipRef}
              role="tooltip"
              // `translate` centers/anchors the pill; framer drives `transform`
              // (scale/opacity/y) separately, so the two never fight.
              style={{
                position: 'fixed',
                left: pos.left,
                top: pos.top,
                translate: pos.place === 'top' ? '-50% -100%' : '-50% 0',
              }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: pos.place === 'top' ? 3 : -3 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.08 } }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-none z-[200] flex max-w-64 items-center gap-2 rounded-md border border-zinc-700/70 bg-zinc-950/95 px-2 py-1 text-xs font-medium leading-snug text-zinc-100 shadow-lg shadow-black/50 ring-1 ring-white/5 backdrop-blur-sm"
            >
              <span>{label}</span>
              {shortcut && (
                <kbd className="flex-none rounded border border-zinc-700 bg-zinc-800/80 px-1 py-px font-mono text-[10px] leading-none tracking-tight text-zinc-400">
                  {shortcut}
                </kbd>
              )}
              {/* Caret. Tucked under the pill by 1px so its top edges stay hidden. */}
              <span
                className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-zinc-950 ${
                  pos.place === 'top'
                    ? 'bottom-px translate-y-1/2 border-b border-r border-zinc-700/70'
                    : 'top-px -translate-y-1/2 border-l border-t border-zinc-700/70'
                }`}
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
