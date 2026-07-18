import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { Command } from '../commands';

/** A rendered menu row: a resolved command, or the `'---'` separator convention. */
export type MenuEntry = Command | '---';

/**
 * A single menu row. Shared by the desktop menu bar and the right-click menu so
 * the two never drift: same icon slot, checkmark, label, shortcut hint, danger
 * and disabled styling. `onRun` closes the surrounding menu after the action.
 */
export function MenuItemRow({ command, onRun }: { command: Command; onRun: () => void }) {
  const { t } = useTranslation();
  const Icon = command.icon;
  const color = command.disabled
    ? 'text-zinc-500'
    : command.danger
      ? 'text-red-300 hover:bg-red-500/10'
      : 'text-zinc-200 hover:bg-zinc-800';
  return (
    <button
      type="button"
      role="menuitem"
      disabled={command.disabled}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs ${color}`}
      onClick={() => {
        command.onClick();
        onRun();
      }}
    >
      <span className="flex h-4 w-4 flex-none items-center justify-center text-zinc-400">
        {command.checked ? (
          <Check className="h-3.5 w-3.5 text-sky-400" />
        ) : Icon ? (
          <Icon className="h-4 w-4" />
        ) : null}
      </span>
      <span className="flex-1 whitespace-nowrap">{t(command.labelKey)}</span>
      {command.shortcut && (
        <span className="flex-none pl-4 font-mono text-[10px] tracking-tight text-zinc-400">
          {command.shortcut}
        </span>
      )}
    </button>
  );
}

/**
 * The item column of a menu panel: rows and separators. The panel chrome
 * (border, background, shadow, positioning) is the caller's job, so this is
 * reused as-is by both the menu-bar dropdowns and the floating context menu.
 * A run of separators (or leading/trailing ones, e.g. after a filtered-out
 * command) collapses so the menu never shows a stray divider.
 */
export function MenuList({ items, onRun }: { items: MenuEntry[]; onRun: () => void }) {
  return (
    <>
      {collapseSeparators(items).map((item, i) =>
        item === '---' ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-zinc-800" />
        ) : (
          <MenuItemRow key={item.id} command={item} onRun={onRun} />
        ),
      )}
    </>
  );
}

/** Drop leading/trailing separators and merge adjacent ones. */
function collapseSeparators(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const item of items) {
    if (item === '---') {
      if (out.length === 0 || out[out.length - 1] === '---') continue;
    }
    out.push(item);
  }
  if (out[out.length - 1] === '---') out.pop();
  return out;
}
