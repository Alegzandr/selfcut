import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Download, Loader2, X, XCircle } from 'lucide-react';
import { useStore } from '../store/store';
import { presetsForAspect, ExportPreset } from './presets';
import { startExport, downloadBlob, ExportHandle } from './exporter';

type Phase =
  | { kind: 'idle' }
  | { kind: 'rendering'; progress: number }
  | { kind: 'done'; filename: string; blob: Blob }
  | { kind: 'error'; message: string };

export function ExportSheet() {
  const open = useStore((s) => s.exportOpen);
  const aspectRatio = useStore((s) => s.project.aspectRatio);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const handleRef = useRef<ExportHandle | null>(null);

  const presets = presetsForAspect(aspectRatio);
  const selected = presets.find((p) => p.id === selectedId) ?? presets[0];

  const close = () => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase({ kind: 'idle' });
    useStore.getState().setExportOpen(false);
  };

  const run = (preset: ExportPreset) => {
    const { project, assets } = useStore.getState();
    setPhase({ kind: 'rendering', progress: 0 });
    const handle = startExport(project, assets, preset, (progress) =>
      setPhase((p) => (p.kind === 'rendering' ? { kind: 'rendering', progress } : p)),
    );
    handleRef.current = handle;
    handle.promise
      .then(({ blob, filename }) => {
        downloadBlob(blob, filename);
        setPhase({ kind: 'done', filename, blob });
      })
      .catch((err: unknown) => {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        handleRef.current = null;
      });
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/60"
            onClick={close}
          />
          <motion.div
            initial={{ y: '110%' }}
            animate={{ y: 0 }}
            exit={{ y: '110%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="fixed inset-x-0 bottom-0 z-50 space-y-3 rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:inset-x-auto md:left-1/2 md:bottom-8 md:w-[26rem] md:-translate-x-1/2 md:rounded-2xl md:border"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">Export</h2>
              <button className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800" onClick={close}>
                <X className="h-4 w-4" />
              </button>
            </div>

            {phase.kind === 'idle' && (
              <>
                <div className="space-y-2">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      className={`block w-full rounded-xl border p-3 text-left ${selected.id === preset.id ? 'border-sky-500 bg-sky-500/10' : 'border-zinc-800 bg-zinc-950 active:bg-zinc-800'}`}
                      onClick={() => setSelectedId(preset.id)}
                    >
                      <div className="text-sm font-medium text-zinc-100">{preset.label}</div>
                      <div className="mt-0.5 text-xs text-zinc-500">{preset.description}</div>
                    </button>
                  ))}
                </div>
                <button
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 py-3 text-sm font-semibold text-white active:bg-sky-600"
                  onClick={() => run(selected)}
                >
                  <Download className="h-4 w-4" />
                  Export {selected.label}
                </button>
                <p className="text-center text-[11px] text-zinc-600">
                  Everything renders on your device — nothing is uploaded.
                </p>
              </>
            )}

            {phase.kind === 'rendering' && (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 text-sm text-zinc-300">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                  Rendering… {Math.round(phase.progress * 100)}%
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
                    style={{ width: `${phase.progress * 100}%` }}
                  />
                </div>
                <button
                  className="w-full rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 active:bg-zinc-800"
                  onClick={() => {
                    handleRef.current?.cancel();
                    handleRef.current = null;
                    setPhase({ kind: 'idle' });
                  }}
                >
                  Cancel
                </button>
              </div>
            )}

            {phase.kind === 'done' && (
              <div className="space-y-3 py-2 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
                <p className="text-sm text-zinc-200">
                  Saved as <span className="font-mono text-xs">{phase.filename}</span>
                </p>
                <div className="flex gap-2">
                  <button
                    className="flex-1 rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 active:bg-zinc-800"
                    onClick={() => downloadBlob(phase.blob, phase.filename)}
                  >
                    Download again
                  </button>
                  <button
                    className="flex-1 rounded-xl bg-sky-500 py-2 text-sm font-semibold text-white active:bg-sky-600"
                    onClick={() => setPhase({ kind: 'idle' })}
                  >
                    New export
                  </button>
                </div>
              </div>
            )}

            {phase.kind === 'error' && (
              <div className="space-y-3 py-2 text-center">
                <XCircle className="mx-auto h-8 w-8 text-red-400" />
                <p className="text-sm text-red-300">{phase.message}</p>
                <button
                  className="w-full rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 active:bg-zinc-800"
                  onClick={() => setPhase({ kind: 'idle' })}
                >
                  Back
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
