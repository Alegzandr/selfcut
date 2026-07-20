import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Current width of the pane being resized, in px. */
  width: number;
  /** Commit a new width. The store clamps it to the pane's own bounds. */
  onWidth: (px: number) => void;
  /** Width restored on double-click. */
  defaultWidth: number;
  /**
   * Which side of the pane the handle sits on. `end` (right edge, the default)
   * grows the pane as the pointer moves right; `start` (left edge, e.g. the
   * inspector) grows it as the pointer moves left.
   */
  side?: 'start' | 'end';
}

/**
 * Draggable vertical divider between two columns - the counterpart of the
 * preview/timeline `SplitHandle`. It resizes from a captured start width plus
 * the pointer delta rather than from an absolute clientX: the pane's left edge
 * is not always at a known offset (the library sits left of the inspector,
 * which itself moves when the library resizes), and a delta needs no such
 * knowledge.
 */
export function ResizeHandle({ width, onWidth, defaultWidth, side = 'end' }: Props) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group relative z-10 -mx-1 w-2 flex-none cursor-col-resize touch-none"
      title={t('app.split.handle')}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, width };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const delta = e.clientX - drag.current.x;
        onWidth(drag.current.width + (side === 'end' ? delta : -delta));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onWidth(defaultWidth)}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:w-1 group-hover:bg-sky-500/60" />
    </div>
  );
}
