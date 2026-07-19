import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * "Priority+" toolbar: reports how many leading groups still fit the row so the
 * caller can fold the tail into an overflow menu. Groups are atomic - a group
 * is either fully on the bar or fully in the menu, never split in half, so the
 * spatial memory of "clipboard is the second cluster" survives a resize.
 *
 * The natural right edge of every group is measured once, on the first pass
 * (which renders them all), and cached: the buttons are icon-only and fixed
 * size, so those edges never change afterwards. Measuring in a layout effect
 * means React re-renders the trimmed row before the browser paints, so the
 * un-trimmed frame is never visible.
 *
 * Groups must be `flex-none` inside the row: that keeps their natural width
 * readable even while the row is too narrow to hold them all, which is what
 * makes the very first measurement reliable when the window starts out small.
 */
export function useToolbarOverflow(groupCount: number) {
  const rowRef = useRef<HTMLDivElement>(null);
  /** Right edge of each group relative to the row's content start, in px. */
  const edgesRef = useRef<number[] | null>(null);
  /** Width of one icon button, i.e. what the overflow trigger will cost. */
  const buttonWidthRef = useRef(32);
  const [visibleCount, setVisibleCount] = useState(groupCount);

  const compute = useCallback(() => {
    const row = rowRef.current;
    const edges = edgesRef.current;
    if (!row || !edges) return;
    const available = row.clientWidth;
    // A zero width means the row is not laid out (hidden ancestor); keep the
    // last known split rather than collapsing everything into the menu.
    if (available <= 0) return;

    if ((edges[edges.length - 1] ?? 0) <= available) {
      setVisibleCount(edges.length);
      return;
    }
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const reserved = buttonWidthRef.current + gap;
    let fitting = 0;
    for (let i = 0; i < edges.length; i++) {
      if (edges[i]! + reserved > available) break;
      fitting = i + 1;
    }
    setVisibleCount(fitting);
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    if (!edgesRef.current) {
      const groups = [...row.querySelectorAll<HTMLElement>('[data-tool-group]')];
      // Only the full, untrimmed pass can be measured.
      const first = groups[0];
      if (!first || groups.length !== groupCount) return;
      const start = first.offsetLeft;
      edgesRef.current = groups.map((el) => el.offsetLeft + el.offsetWidth - start);
      const button = first.firstElementChild;
      if (button instanceof HTMLElement && button.offsetWidth > 0) {
        buttonWidthRef.current = button.offsetWidth;
      }
    }

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    return () => observer.disconnect();
  }, [compute, groupCount]);

  return { rowRef, visibleCount };
}
