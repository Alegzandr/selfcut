import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileX2, FolderOpen, Redo2, Undo2 } from 'lucide-react';
import { APP_NAME } from '../app/config';
import logoUrl from '../assets/logo.png';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { AspectRatio } from '../types';

const ASPECTS = [
  { value: '16:9', titleKey: 'topbar.aspect.16x9' },
  { value: '9:16', titleKey: 'topbar.aspect.9x16' },
  { value: '1:1', titleKey: 'topbar.aspect.1x1' },
  { value: '4:5', titleKey: 'topbar.aspect.4x5' },
] as const satisfies readonly { value: AspectRatio; titleKey: string }[];

/**
 * "New project" without a native confirm(): the first press arms the button
 * (it turns into an explicit red "Discard?"), a second press within 4s resets.
 */
function NewProjectButton() {
  const { t } = useTranslation();
  const { resetProject } = useStore.getState();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <Tooltip label={t('topbar.newProject.confirm')}>
        <button
          className="flex items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-300 active:bg-red-500/30"
          onClick={() => {
            setArmed(false);
            resetProject();
          }}
          onBlur={() => setArmed(false)}
        >
          <FileX2 className="h-4 w-4" />
          {t('topbar.newProject.armed')}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={t('topbar.newProject.title')}>
      <button
        className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
        onClick={() => setArmed(true)}
      >
        <FileX2 className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const aspectRatio = useStore((s) => s.project.aspectRatio);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const assetCount = useStore((s) => Object.keys(s.assets).length);
  const coarse = useIsCoarsePointer();
  const { setAspectRatio, undo, redo, setExportOpen, setLibraryOpen } = useStore.getState();

  return (
    <header className="flex h-12 flex-none items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 sm:gap-2 sm:px-3">
      {/* Desktop shows the logo/name in the menu bar above; only mobile
          (which has no menu bar) needs the branding here. */}
      {coarse && (
        <div className="flex items-center gap-1.5 pr-1">
          <img src={logoUrl} alt="" className="h-6 w-6 select-none" draggable={false} />
          <span className="hidden text-sm font-bold tracking-wide text-zinc-100 sm:inline">
            {APP_NAME}
          </span>
        </div>
      )}

      <div className="flex overflow-hidden rounded-lg border border-zinc-700">
        {ASPECTS.map(({ value, titleKey }) => (
          <Tooltip key={value} label={t(titleKey)}>
            <button
              className={`px-2 py-1.5 text-xs tabular-nums ${aspectRatio === value ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 active:bg-zinc-800'}`}
              onClick={() => setAspectRatio(value)}
            >
              {value}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Mobile: the media library lives in a drawer. */}
      {coarse && (
        <button
          className="relative rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
          onClick={() => setLibraryOpen(true)}
          title={t('topbar.library')}
        >
          <FolderOpen className="h-4 w-4" />
          {assetCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-sky-500 px-1 text-[9px] font-bold leading-3.5 text-white">
              {assetCount}
            </span>
          )}
        </button>
      )}

      <div className="mx-auto" />

      <NewProjectButton />

      <Tooltip label={t('topbar.undo')} shortcut="Ctrl+Z">
        <button
          className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
          disabled={!canUndo}
          onClick={undo}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      </Tooltip>
      <Tooltip label={t('topbar.redo')} shortcut="Ctrl+Shift+Z">
        <button
          className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
          disabled={!canRedo}
          onClick={redo}
        >
          <Redo2 className="h-4 w-4" />
        </button>
      </Tooltip>

      {/* Add / Import are covered by the Insert & File menus on desktop, and by
          the CapCut-style bottom tool rail on touch - no toolbar duplicate here. */}
      <Tooltip label={t('topbar.exportHint')} shortcut="Ctrl+E">
        <button
          className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-white active:bg-sky-600"
          onClick={() => setExportOpen(true)}
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">{t('topbar.export')}</span>
        </button>
      </Tooltip>
    </header>
  );
}
