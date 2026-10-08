import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store/store';
import { MenuList } from './MenuList';
import { useContextMenuItems } from './menus';
import type { ContextMenuState } from '../../store/editorState';

/**
 * Desktop right-click menu. A single instance lives at the app root; it reads
 * the open target from the store and portals a floating panel to `document.body`
 * at the click coordinates, flipping at the viewport edges (à la `Tooltip`).
 * Closes on outside pointer-down, Escape, scroll, resize, or after a command.
 */
export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  if (!menu) return null;
  // Key by position so a fresh right-click remounts the panel (re-measures, re-clamps).
  return <ContextMenuPanel key={`${menu.x},${menu.y}`} menu={menu} />;
}

/** Gap kept between the panel and the viewport edge when it has to flip/clamp. */
const EDGE_MARGIN_PX = 8;

function ContextMenuPanel({ menu }: { menu: ContextMenuState }) {
  const close = useStore((s) => s.closeContextMenu);
  const items = useContextMenuItems(menu.target);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place after measuring: flip left/up when the panel would overflow the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE_MARGIN_PX;
    const maxTop = window.innerHeight - height - EDGE_MARGIN_PX;
    setPos({
      left: Math.max(EDGE_MARGIN_PX, Math.min(menu.x, maxLeft)),
      top: Math.max(EDGE_MARGIN_PX, Math.min(menu.y, maxTop)),
    });
  }, [menu.x, menu.y, items.length]);

  // Dismiss on any interaction that would move or invalidate the anchor.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [close]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[200] min-w-52 popover p-1"
      style={{
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        // Hide the pre-measurement paint so the panel never flashes at the raw click point.
        visibility: pos ? 'visible' : 'hidden',
      }}
      // The panel spawned from a right-click; keep a right-click on it from
      // opening the native menu on top.
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={items} onRun={close} />
    </div>,
    document.body,
  );
}
