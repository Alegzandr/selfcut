import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import { CheckCircle2, Download, Loader2, X, XCircle } from 'lucide-react';
import { useStore } from '../store/store';
import { formatTime } from '../lib/time';
import { presetsForAspect, ExportPreset } from './presets';
import { startExport, downloadBlob, ExportHandle } from './exporter';

type Phase =
  | { kind: 'idle' }
  | { kind: 'rendering'; progress: number }
  | { kind: 'done'; filename: string; blob: Blob }
  | { kind: 'error'; message: string };

export function ExportSheet() {
  const { t } = useTranslation();
  const open = useStore((s) => s.exportOpen);
  const aspectRatio = useStore((s) => s.project.aspectRatio);
  const region = useStore((s) => s.loopRegion);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [regionOnly, setRegionOnly] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const handleRef = useRef<ExportHandle | null>(null);

  const presets = presetsForAspect(aspectRatio);
  const selected = presets.find((p) => p.id === selectedId) ?? presets[0];
  const exportedRegion = region && regionOnly ? region : null;

  const close = () => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase({ kind: 'idle' });
    useStore.getState().setExportOpen(false);
  };

  // Escape closes the sheet - except mid-render, where closing would silently
  // throw away the export (cancel stays an explicit button press).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (phase.kind !== 'rendering') close();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase.kind]);

  const run = (preset: ExportPreset) => {
    const { project, assets } = useStore.getState();
    setPhase({ kind: 'rendering', progress: 0 });
    const handle = startExport(
      project,
      assets,
      preset,
      (progress) => setPhase((p) => (p.kind === 'rendering' ? { kind: 'rendering', progress } : p)),
      exportedRegion,
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
              <h2 className="text-sm font-semibold text-zinc-100">{t('export.title')}</h2>
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
                      <div className="text-sm font-medium text-zinc-100">
                        {t(preset.labelKey)}{preset.qualityKey && ` · ${t(preset.qualityKey)}`}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {preset.kind === 'mp4'
                          ? t(preset.descriptionKey, {
                              fps: preset.fps,
                              width: preset.width,
                              height: preset.height,
                              bitrate: Math.round(preset.videoBitrate / 1_000_000),
                            })
                          : t(preset.descriptionKey, {
                              bitrate: Math.round(preset.audioBitrate / 1_000),
                            })}
                      </div>
                    </button>
                  ))}
                </div>

                {region && (
                  <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={regionOnly}
                      onChange={(e) => setRegionOnly(e.target.checked)}
                      className="h-3.5 w-3.5 accent-amber-400"
                    />
                    {t('export.regionOnly')}{' '}
                    <span className="font-mono text-amber-200">
                      {formatTime(region.startMs)} → {formatTime(region.endMs)}
                    </span>
                  </label>
                )}

                <button
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 py-3 text-sm font-semibold text-white active:bg-sky-600"
                  onClick={() => run(selected)}
                >
                  <Download className="h-4 w-4" />
                  {t(exportedRegion ? 'export.cta.region' : 'export.cta', {
                    preset: `${t(selected.labelKey)}${selected.qualityKey ? ` · ${t(selected.qualityKey)}` : ''}`,
                  })}
                </button>
                <p className="text-center text-[11px] text-zinc-600">{t('export.privacy')}</p>
              </>
            )}

            {phase.kind === 'rendering' && (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 text-sm text-zinc-300">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                  {t('export.rendering', { pct: Math.round(phase.progress * 100) })}
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
                  {t('export.cancel')}
                </button>
              </div>
            )}

            {phase.kind === 'done' && (
              <div className="space-y-3 py-2 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
                <p className="text-sm text-zinc-200">
                  {/* The file name keeps its monospace styling, hence <Trans>. */}
                  <Trans
                    i18nKey="export.saved"
                    values={{ filename: phase.filename }}
                    components={{ name: <span className="font-mono text-xs" /> }}
                  />
                </p>
                <div className="flex gap-2">
                  <button
                    className="flex-1 rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 active:bg-zinc-800"
                    onClick={() => downloadBlob(phase.blob, phase.filename)}
                  >
                    {t('export.downloadAgain')}
                  </button>
                  <button
                    className="flex-1 rounded-xl bg-sky-500 py-2 text-sm font-semibold text-white active:bg-sky-600"
                    onClick={() => setPhase({ kind: 'idle' })}
                  >
                    {t('export.newExport')}
                  </button>
                </div>
              </div>
            )}

            {phase.kind === 'error' && (
              <div className="space-y-3 py-2 text-center">
                <XCircle className="mx-auto h-8 w-8 text-red-400" />
                {/* Already translated by the exporter, worker codes included. */}
                <p className="text-sm text-red-300">{phase.message}</p>
                <button
                  className="w-full rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 active:bg-zinc-800"
                  onClick={() => setPhase({ kind: 'idle' })}
                >
                  {t('export.back')}
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
