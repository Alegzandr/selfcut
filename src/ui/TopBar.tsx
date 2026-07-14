import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FilePlus, FileX2, FolderOpen, Plus, Redo2, Square, Type, Undo2 } from 'lucide-react';
import { APP_NAME } from '../app/config';
import logoUrl from '../assets/logo.png';
import { useStore } from '../store/store';
import { useImport } from './useImport';
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
      <button
        className="flex items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-300 active:bg-red-500/30"
        onClick={() => {
          setArmed(false);
          resetProject();
        }}
        onBlur={() => setArmed(false)}
        title={t('topbar.newProject.confirm')}
      >
        <FileX2 className="h-4 w-4" />
        {t('topbar.newProject.armed')}
      </button>
    );
  }
  return (
    <button
      className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
      onClick={() => setArmed(true)}
      title={t('topbar.newProject.title')}
    >
      <FileX2 className="h-4 w-4" />
    </button>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const aspectRatio = useStore((s) => s.project.aspectRatio);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const assetCount = useStore((s) => Object.keys(s.assets).length);
  const coarse = useIsCoarsePointer();
  const { setAspectRatio, undo, redo, setExportOpen, addTextClip, addSolidClip, setLibraryOpen } = useStore.getState();
  const importFiles = useImport();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <header className="flex h-12 flex-none items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 sm:gap-2 sm:px-3">
      <div className="flex items-center gap-1.5 pr-1">
        <img src={logoUrl} alt="" className="h-6 w-6 select-none" draggable={false} />
        <span className="hidden text-sm font-bold tracking-wide text-zinc-100 sm:inline">
          {APP_NAME}
        </span>
      </div>

      <div className="flex overflow-hidden rounded-lg border border-zinc-700">
        {ASPECTS.map(({ value, titleKey }) => (
          <button
            key={value}
            className={`px-2 py-1.5 text-xs tabular-nums ${aspectRatio === value ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 active:bg-zinc-800'}`}
            onClick={() => setAspectRatio(value)}
            title={t(titleKey)}
          >
            {value}
          </button>
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

      <button
        className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
        disabled={!canUndo}
        onClick={undo}
        title={t('topbar.undo')}
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
        disabled={!canRedo}
        onClick={redo}
        title={t('topbar.redo')}
      >
        <Redo2 className="h-4 w-4" />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*,.mp4,.mov,.webm,.mkv,.mp3,.wav,.m4a,.aac,.ogg,.flac,.srt,.vtt"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void importFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="relative">
        <button
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 active:bg-zinc-800"
          onClick={() => setCreateOpen((open) => !open)}
          title={t('topbar.add')}
          aria-expanded={createOpen}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">{t('topbar.add')}</span>
        </button>
        {createOpen && (
          <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/40">
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-zinc-200 active:bg-zinc-800" onClick={() => { addTextClip(); setCreateOpen(false); }}>
              <Type className="h-4 w-4 text-violet-300" />
              <span>{t('topbar.text')}</span>
            </button>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-zinc-200 active:bg-zinc-800" onClick={() => { addSolidClip('color'); setCreateOpen(false); }}>
              <Square className="h-4 w-4 text-indigo-300" />
              <span>{t('topbar.solidColor')}</span>
            </button>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-zinc-200 active:bg-zinc-800" onClick={() => { addSolidClip('gradient'); setCreateOpen(false); }}>
              <Square className="h-4 w-4 text-pink-300" />
              <span>{t('topbar.solidGradient')}</span>
            </button>
          </div>
        )}
      </div>
      <button
        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 active:bg-zinc-800"
        onClick={() => fileInputRef.current?.click()}
      >
        <FilePlus className="h-4 w-4" />
        <span className="hidden sm:inline">{t('topbar.import')}</span>
      </button>
      <button
        className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-white active:bg-sky-600"
        onClick={() => setExportOpen(true)}
      >
        <Download className="h-4 w-4" />
        <span className="hidden sm:inline">{t('topbar.export')}</span>
      </button>
    </header>
  );
}
