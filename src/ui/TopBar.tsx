import { useRef } from 'react';
import { Clapperboard, Download, FilePlus, Redo2, RectangleHorizontal, RectangleVertical, Undo2 } from 'lucide-react';
import { APP_NAME } from '../app/config';
import { useStore } from '../store/store';
import { useImport } from './useImport';

export function TopBar() {
  const aspectRatio = useStore((s) => s.project.aspectRatio);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const { setAspectRatio, undo, redo, setExportOpen } = useStore.getState();
  const importFiles = useImport();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <header className="flex h-12 flex-none items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 sm:gap-2 sm:px-3">
      <div className="flex items-center gap-1.5 pr-1 text-sky-400">
        <Clapperboard className="h-5 w-5" />
        <span className="hidden text-sm font-bold tracking-wide text-zinc-100 sm:inline">
          {APP_NAME}
        </span>
      </div>

      <div className="flex overflow-hidden rounded-lg border border-zinc-700">
        <button
          className={`flex items-center gap-1 px-2 py-1.5 text-xs ${aspectRatio === '16:9' ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 active:bg-zinc-800'}`}
          onClick={() => setAspectRatio('16:9')}
          title="Landscape 16:9"
        >
          <RectangleHorizontal className="h-4 w-4" />
          <span className="hidden md:inline">16:9</span>
        </button>
        <button
          className={`flex items-center gap-1 px-2 py-1.5 text-xs ${aspectRatio === '9:16' ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 active:bg-zinc-800'}`}
          onClick={() => setAspectRatio('9:16')}
          title="Portrait 9:16"
        >
          <RectangleVertical className="h-4 w-4" />
          <span className="hidden md:inline">9:16</span>
        </button>
      </div>

      <div className="mx-auto" />

      <button
        className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
        disabled={!canUndo}
        onClick={undo}
        title="Undo"
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
        disabled={!canRedo}
        onClick={redo}
        title="Redo"
      >
        <Redo2 className="h-4 w-4" />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*,.mp4,.mov,.webm,.mkv,.mp3,.wav,.m4a,.aac,.ogg,.flac"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void importFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 active:bg-zinc-800"
        onClick={() => fileInputRef.current?.click()}
      >
        <FilePlus className="h-4 w-4" />
        <span className="hidden sm:inline">Import</span>
      </button>
      <button
        className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-white active:bg-sky-600"
        onClick={() => setExportOpen(true)}
      >
        <Download className="h-4 w-4" />
        <span className="hidden sm:inline">Export</span>
      </button>
    </header>
  );
}
