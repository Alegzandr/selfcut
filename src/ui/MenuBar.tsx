import { useEffect, useRef, useState } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import logoUrl from '../assets/logo.png';
import { APP_NAME } from '../app/config';
import { useEditorCommands } from './commands';
import { MenuList, type MenuEntry } from './menu/MenuList';
import { MasterVolume } from './MasterVolume';

/**
 * Desktop menu bar (File / Edit / …). The menu *structure* lives here as ids
 * into the shared command map; `'---'` is a separator. A menu opens on click and,
 * while any menu is open, switches on hover - the standard desktop menu-bar feel.
 */
type Menu = { titleKey: ParseKeys; items: readonly string[] };

const MENUS: readonly Menu[] = [
  {
    titleKey: 'menu.file',
    items: [
      'file.new',
      'file.open',
      '---',
      'file.save',
      'file.saveAs',
      '---',
      'file.import',
      'file.importSubtitles',
      'file.importPreset',
      'file.savePreset',
      '---',
      'file.export',
    ],
  },
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
    items: ['clip.split', 'clip.duplicate', '---', 'clip.punchIn', 'clip.stream', 'clip.link', 'clip.unlink', '---', 'clip.delete', 'clip.rippleDelete'],
  },
  {
    titleKey: 'menu.view',
    // The shortcuts panel lives under Help alone: it was in both menus, the
    // same command listed twice under the same label.
    items: [
      'view.zoomIn',
      'view.zoomOut',
      '---',
      'view.media',
      'view.effects',
      'view.transitions',
      '---',
      'view.subtitles',
      '---',
      'view.snap',
    ],
  },
  {
    titleKey: 'menu.playback',
    items: ['playback.playPause', 'playback.start', '---', 'playback.loop', 'playback.regionIn', 'playback.regionOut'],
  },
  { titleKey: 'menu.help', items: ['help.shortcuts', '---', 'help.about'] },
];

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
              <div role="menu" className="absolute left-0 top-full z-50 mt-0.5 min-w-56 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/50">
                <MenuList
                  items={menu.items
                    .map((item): MenuEntry | null => (item === '---' ? '---' : commands[item] ?? null))
                    .filter((e): e is MenuEntry => e !== null)}
                  onRun={() => setOpen(null)}
                />
              </div>
            )}
          </div>
        );
      })}

      <div className="ml-auto" />
      <MasterVolume />
    </div>
  );
}
