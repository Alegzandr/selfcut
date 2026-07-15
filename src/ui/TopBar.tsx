import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  FileX2,
  Flag,
  FolderOpen,
  Keyboard,
  Magnet,
  Redo2,
  Scissors,
  StretchHorizontal,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { APP_NAME } from '../app/config';
import logoUrl from '../assets/logo.png';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { AspectRatio } from '../types';
import { zoomAtPlayhead, zoomToFit } from '../timeline/zoom';

const ASPECTS = [
  { value: '16:9', titleKey: 'topbar.aspect.16x9' },
  { value: '9:16', titleKey: 'topbar.aspect.9x16' },
  { value: '1:1', titleKey: 'topbar.aspect.1x1' },
  { value: '4:5', titleKey: 'topbar.aspect.4x5' },
] as const satisfies readonly { value: AspectRatio; titleKey: string }[];

/**
 * "New project" without a native confirm(): the first press arms the button
 * (it turns into an explicit red "Discard?"), a second press within 4s resets.
 * Touch only - on desktop the File menu owns "New project".
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
  const hasSelection = useStore((s) => s.selectedClipIds.length > 0);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const coarse = useIsCoarsePointer();
  const {
    setAspectRatio,
    undo,
    redo,
    setExportOpen,
    setLibraryOpen,
    splitAtPlayhead,
    deleteClips,
    toggleSnap,
    addMarkerAtPlayhead,
    setShortcutsOpen,
  } = useStore.getState();

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

      {/* Editing / view tools, relocated from the transport bar so the transport
          stays a pure playback control. Touch keeps them in the bottom tool rail
          (split/delete) and pinch-to-zoom, so this group is desktop only. */}
      {!coarse && (
        <>
          <Tooltip label={t('transport.addMarker')}>
            <button
              className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
              onClick={addMarkerAtPlayhead}
            >
              <Flag className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label={t('transport.split')}>
            <button
              className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
              onClick={() => splitAtPlayhead()}
            >
              <Scissors className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label={t('transport.delete')}>
            <button
              className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
              disabled={!hasSelection}
              onClick={() => deleteClips(useStore.getState().selectedClipIds, false)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label={snapEnabled ? t('transport.snapping.on') : t('transport.snapping.off')}>
            <button
              className={`rounded-lg p-2 ${snapEnabled ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-500'} active:bg-zinc-800`}
              onClick={toggleSnap}
            >
              <Magnet className="h-4 w-4" />
            </button>
          </Tooltip>

          <div className="mx-1 h-5 w-px bg-zinc-800" />

          <Tooltip label={t('transport.zoomOut')}>
            <button
              className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
              onClick={() => zoomAtPlayhead(1 / 1.4)}
            >
              <ZoomOut className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label={t('transport.zoomIn')}>
            <button
              className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
              onClick={() => zoomAtPlayhead(1.4)}
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label={t('transport.zoomFit')}>
            <button
              className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
              onClick={() => zoomToFit()}
            >
              <StretchHorizontal className="h-4 w-4" />
            </button>
          </Tooltip>

          <div className="mx-1 h-5 w-px bg-zinc-800" />

          <Tooltip label={t('transport.shortcuts')}>
            <button
              className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
              onClick={() => setShortcutsOpen(true)}
            >
              <Keyboard className="h-4 w-4" />
            </button>
          </Tooltip>
        </>
      )}

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

      {/* New project + Export live in the File menu on desktop; touch has no menu
          bar, so keep them reachable here. */}
      {coarse && <NewProjectButton />}

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

      {coarse && (
        <Tooltip label={t('topbar.exportHint')} shortcut="Ctrl+E">
          <button
            className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-white active:bg-sky-600"
            onClick={() => setExportOpen(true)}
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t('topbar.export')}</span>
          </button>
        </Tooltip>
      )}

      {/* Aspect ratio picker, pinned to the far right. */}
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
    </header>
  );
}
