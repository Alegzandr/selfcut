import { Keyboard, Pause, Play, Scissors, SkipBack, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { formatTime } from '../lib/time';
import { useIsCoarsePointer } from '../lib/device';

function TimeReadout() {
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const durationMs = useStore((s) => projectDurationMs(s.project));
  return (
    <span className="min-w-[92px] text-center font-mono text-xs tabular-nums text-zinc-400">
      <span className="text-zinc-100">{formatTime(currentTimeMs)}</span> / {formatTime(durationMs)}
    </span>
  );
}

export function Transport() {
  const playing = useStore((s) => s.playing);
  const hasSelection = useStore((s) => s.selectedClipId !== null);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const coarse = useIsCoarsePointer();
  const { setPlaying, seek, splitAtPlayhead, deleteClip, setPxPerSec, setShortcutsOpen } =
    useStore.getState();

  return (
    <div className="flex h-11 flex-none items-center justify-center gap-1 border-y border-zinc-800 bg-zinc-900 px-2">
      <button
        className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
        onClick={() => seek(0)}
        title="Back to start (Home)"
      >
        <SkipBack className="h-4 w-4" />
      </button>
      <button
        className="rounded-full bg-zinc-100 p-2.5 text-zinc-950 active:bg-white"
        onClick={() => setPlaying(!playing)}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
      </button>
      <TimeReadout />

      {/* Touch devices: split/delete live in the clip action bar, zoom is pinch. */}
      {!coarse && (
        <>
          <div className="mx-1 h-5 w-px bg-zinc-800" />

          <button
            className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
            onClick={() => splitAtPlayhead()}
            title="Split at playhead (S)"
          >
            <Scissors className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg p-2 text-zinc-400 enabled:active:bg-zinc-800 disabled:opacity-30"
            disabled={!hasSelection}
            onClick={() => {
              const id = useStore.getState().selectedClipId;
              if (id) deleteClip(id);
            }}
            title="Delete selected clip (Del)"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          <div className="mx-1 h-5 w-px bg-zinc-800" />

          <button
            className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
            onClick={() => setPxPerSec(pxPerSec / 1.4)}
            title="Zoom out (↓)"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
            onClick={() => setPxPerSec(pxPerSec * 1.4)}
            title="Zoom in (↑)"
          >
            <ZoomIn className="h-4 w-4" />
          </button>

          <div className="mx-1 h-5 w-px bg-zinc-800" />

          <button
            className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
