import { useEffect, useRef, useState } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import logoUrl from '../assets/logo.png';
import { APP_NAME } from '../app/config';
import { useEditorCommands, type Command } from './commands';

/**
 * Desktop menu bar (File / Edit / …). The menu *structure* lives here as ids
 * into the shared command map; `'---'` is a separator. A menu opens on click and,
 * while any menu is open, switches on hover - the standard desktop menu-bar feel.
 */
type Menu = { titleKey: ParseKeys; items: readonly string[] };

const MENUS: readonly Menu[] = [
  { titleKey: 'menu.file', items: ['file.new', 'file.import', '---', 'file.export'] },
  {
    titleKey: 'menu.edit',
    items: ['edit.undo', 'edit.redo', '---', 'edit.cut', 'edit.copy', 'edit.paste', '---', 'edit.selectAll', '---', 'edit.preferences'],
  },
  {
    titleKey: 'menu.insert',
    items: ['insert.text', 'insert.color', 'insert.gradient', '---', 'insert.videoTrack', 'insert.audioTrack', '---', 'insert.marker'],
  },
  {
    titleKey: 'menu.clip',
    items: ['clip.split', 'clip.duplicate', '---', 'clip.punchIn', 'clip.stream', '---', 'clip.delete', 'clip.rippleDelete'],
  },
  {
    titleKey: 'menu.view',
    items: ['view.zoomIn', 'view.zoomOut', 'view.zoomFit', '---', 'view.snap', '---', 'view.shortcuts'],
  },
  {
    titleKey: 'menu.playback',
    items: ['playback.playPause', 'playback.start', '---', 'playback.loop', 'playback.regionIn', 'playback.regionOut'],
  },
  { titleKey: 'menu.help', items: ['help.shortcuts', '---', 'help.about'] },
];

function MenuItem({ command, onRun }: { command: Command | undefined; onRun: () => void }) {
  const { t } = useTranslation();
  if (!command) return null;
  const Icon = command.icon;
  const color = command.disabled
    ? 'text-zinc-600'
    : command.danger
      ? 'text-red-300 hover:bg-red-500/10'
      : 'text-zinc-200 hover:bg-zinc-800';
  return (
    <button
      type="button"
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
        <span className="flex-none pl-4 font-mono text-[10px] tracking-tight text-zinc-500">
          {command.shortcut}
        </span>
      )}
    </button>
  );
}

export function MenuBar() {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  const [open, setOpen] = useState<ParseKeys | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={barRef}
      className="relative z-40 flex h-8 flex-none items-center gap-0.5 border-b border-zinc-800 bg-zinc-900 px-2 text-xs"
    >
      <div className="flex select-none items-center gap-1.5 pr-2">
        <img src={logoUrl} alt="" className="h-4 w-4" draggable={false} />
        <span className="font-semibold tracking-wide text-zinc-200">{APP_NAME}</span>
      </div>

      {MENUS.map((menu) => {
        const isOpen = open === menu.titleKey;
        return (
          <div key={menu.titleKey} className="relative">
            <button
              type="button"
              className={`rounded px-2.5 py-1 ${isOpen ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'}`}
              onClick={() => setOpen(isOpen ? null : menu.titleKey)}
              onMouseEnter={() => open && setOpen(menu.titleKey)}
              aria-expanded={isOpen}
            >
              {t(menu.titleKey)}
            </button>
            {isOpen && (
              <div className="absolute left-0 top-full z-50 mt-0.5 min-w-56 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/50">
                {menu.items.map((item, i) =>
                  item === '---' ? (
                    <div key={`sep-${i}`} className="my-1 h-px bg-zinc-800" />
                  ) : (
                    <MenuItem key={item} command={commands[item]} onRun={() => setOpen(null)} />
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="ml-auto" />
    </div>
  );
}
