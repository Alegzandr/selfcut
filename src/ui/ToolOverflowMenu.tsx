import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { MoreHorizontal } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { MenuList, type MenuEntry } from './menu/MenuList';
import { MenuPanel, useDismissOnOutside } from './menu/MenuPanel';

/**
 * The tail of the toolbar, folded into a dropdown when the window is too narrow
 * to show every tool group. The rows come from the same command objects as the
 * buttons they replace, so a tool keeps its icon, its label and its shortcut
 * hint on the way in - and the shortcut itself keeps working regardless.
 *
 * The panel is anchored to the trigger's left edge: the tail folds away from
 * the right, so the trigger always has room on its right when this is visible.
 */
export function ToolOverflowMenu({ entries }: { entries: MenuEntry[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, () => setOpen(false), rootRef);

  return (
    <div ref={rootRef} className="relative flex-none">
      <Tooltip label={t('topbar.moreTools')} disabled={open}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`touch-hit rounded-lg p-2 active:bg-zinc-800 ${
            open ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <MenuPanel className="left-0 top-full mt-1 min-w-44">
            <MenuList items={entries} onRun={() => setOpen(false)} />
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}
