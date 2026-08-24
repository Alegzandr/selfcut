import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  DownloadIcon,
  UpdateIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { formatTime } from '../lib/time';
import {
  fpsCapBinds,
  presetSectionsForAspect,
  projectSourceFps,
  resolveMp4Preset,
  ExportPreset,
  type ExportVideoCodec,
  PresetGroup,
} from './presets';

/**
 * How each codec is named in the row that describes what will be encoded.
 *
 * Not translated: these are the codecs' own names, and "H.265" is "H.265" in
 * every locale. The row used to say "H.264" for all three, so the HEVC and AV1
 * presets described themselves as the codec they exist to avoid.
 */
const CODEC_LABELS: Record<ExportVideoCodec, string> = {
  avc: 'H.264',
  hevc: 'H.265',
  av1: 'AV1',
};
import {
  startExport,
  downloadBlob,
  ExportCanceledError,
  type ExportFallback,
  ExportHandle,
} from './exporter';
import {
  estimateRemainingMs,
  formatDuration,
  formatRemaining,
  pushSample,
  ProgressSample,
} from './renderClock';

type Phase =
  | { kind: 'idle' }
  /**
   * `fallback` is set when the encoder stopped responding and the render
   * started over on gentler terms. It is the only thing standing between the
   * user and a progress bar that visibly went backwards for no reason.
   */
  | { kind: 'rendering'; progress: number; fallback?: ExportFallback }
  /** `blob` is null when the render went straight to the file the user picked. */
  | { kind: 'done'; filename: string; blob: Blob | null }
  | { kind: 'error'; message: string };

/**
 * Elapsed / remaining readout for the render in flight.
 *
 * It runs its own ticker rather than deriving the time from `progress`: the
 * worker only reports every few frames, and a big frame can stall the callback
 * for seconds - the elapsed time has to keep moving anyway.
 */
function useRenderClock(rendering: boolean, progress: number) {
  const [clock, setClock] = useState<{ elapsedMs: number; remainingMs: number | null }>({
    elapsedMs: 0,
    remainingMs: null,
  });
  const startedAtRef = useRef<number | null>(null);
  const samplesRef = useRef<ProgressSample[]>([]);

  const update = useCallback(() => {
    const startedAt = startedAtRef.current;
    if (startedAt === null) return;
    const now = performance.now();
    setClock({
      elapsedMs: now - startedAt,
      remainingMs: estimateRemainingMs(samplesRef.current, now),
    });
  }, []);

  useEffect(() => {
    if (!rendering) {
      startedAtRef.current = null;
      samplesRef.current = [];
      setClock({ elapsedMs: 0, remainingMs: null });
      return;
    }
    const startedAt = performance.now();
    startedAtRef.current = startedAt;
    samplesRef.current = [{ atMs: startedAt, progress: 0 }];
    setClock({ elapsedMs: 0, remainingMs: null });
    // Twice a second, so a whole-second readout never lags visibly behind.
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [rendering, update]);

  useEffect(() => {
    if (startedAtRef.current === null) return;
    samplesRef.current = pushSample(samplesRef.current, {
      atMs: performance.now(),
      progress,
    });
    update();
  }, [progress, update]);

  return clock;
}

export function ExportSheet() {
  const { t } = useTranslation();
  const open = useStore((s) => s.exportOpen);
  const project = useStore((s) => s.project);
  const assets = useStore((s) => s.assets);
  const aspectRatio = project.aspectRatio;
  const region = useStore((s) => s.loopRegion);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [group, setGroup] = useState<PresetGroup>('social');
  const [regionOnly, setRegionOnly] = useState(true);
  /**
   * Off by default, and deliberately not remembered between exports: the extra
   * frames are duplicates of what was filmed, so paying for them has to be a
   * choice made about THIS render rather than one made once and forgotten.
   */
  const [forceMaxFps, setForceMaxFps] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const handleRef = useRef<ExportHandle | null>(null);
  // Set when the user cancels: the promise then rejects with "canceled", which
  // must land back on the idle screen, not on the error screen.
  const canceledRef = useRef(false);

  // Never empty: the audio presets fit every aspect ratio, and 'social' always
  // has the destination for this one.
  const sections = presetSectionsForAspect(aspectRatio);
  const active = sections.find((s) => s.group === group) ?? sections[0]!;
  // The pick is resolved inside the visible category, so switching category
  // falls back to its first preset and the CTA always names a row on screen -
  // while `selectedId` still remembers the choice made in another category.
  const selected = active.presets.find((p) => p.id === selectedId) ?? active.presets[0]!;
  const exportedRegion = region && regionOnly ? region : null;
  const { elapsedMs, remainingMs } = useRenderClock(
    phase.kind === 'rendering',
    phase.kind === 'rendering' ? phase.progress : 0,
  );

  const close = () => {
    canceledRef.current = true;
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
    canceledRef.current = false;
    setPhase({ kind: 'rendering', progress: 0 });
    const handle = startExport(
      project,
      assets,
      preset,
      (progress) =>
        setPhase((p) => (p.kind === 'rendering' ? { ...p, kind: 'rendering', progress } : p)),
      exportedRegion,
      {
        forceMaxFps,
        onFallback: (fallback) =>
          setPhase((p) => (p.kind === 'rendering' ? { ...p, fallback } : p)),
      },
    );
    handleRef.current = handle;
    handle.promise
      .then(({ blob, filename }) => {
        // Nothing to download when the worker streamed into the user's file.
        if (blob) downloadBlob(blob, filename);
        setPhase({ kind: 'done', filename, blob });
      })
      .catch((err: unknown) => {
        // User-initiated (cancel button, or dismissing the save picker): back
        // to idle, not an error.
        if (canceledRef.current || err instanceof ExportCanceledError) {
          setPhase({ kind: 'idle' });
          return;
        }
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
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            // Lighter while rendering: the preview behind it is showing the
            // frame being encoded, and a scrim built to push a picker forward
            // is the wrong amount of black in front of the thing being watched.
            className={`fixed inset-0 z-40 ${phase.kind === 'rendering' ? 'bg-black/25' : 'bg-black/60'}`}
            // Mid-render, a stray tap outside the sheet must not silently kill
            // an export: cancel stays an explicit button press.
            onClick={() => {
              if (phase.kind !== 'rendering') close();
            }}
          />
          <m.div
            initial={{ y: '110%' }}
            animate={{ y: 0 }}
            exit={{ y: '110%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            role="dialog"
            aria-modal="true"
            aria-label={t('export.title')}
            className="fixed inset-x-0 bottom-0 z-50 space-y-3 rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:inset-x-auto md:left-1/2 md:bottom-8 md:w-[26rem] md:-translate-x-1/2 md:rounded-2xl md:border"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">{t('export.title')}</h2>
              <button
                className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 disabled:opacity-40 pointer-coarse:p-2.5"
                aria-label={t('export.close')}
                // Mid-render the X must not silently throw the export away, same
                // as Escape and the backdrop: cancel stays an explicit button.
                disabled={phase.kind === 'rendering'}
                onClick={() => {
                  if (phase.kind !== 'rendering') close();
                }}
              >
                <Cross2Icon className="h-4 w-4" />
              </button>
            </div>

            {phase.kind === 'idle' && (
              <>
                {/* One category at a time: all three lists stacked would bury
                    everything but the platform presets under a scroll. */}
                <div className="flex gap-1" role="group" aria-label={t('export.category')}>
                  {sections.map((section) => (
                    <button
                      key={section.group}
                      type="button"
                      aria-pressed={section.group === active.group}
                      onClick={() => setGroup(section.group)}
                      className={`touch-hit flex-1 rounded-lg px-2 py-1.5 text-2xs font-medium ${
                        section.group === active.group
                          ? 'bg-sky-500/20 text-sky-300'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                      }`}
                    >
                      {t(section.titleKey)}
                    </button>
                  ))}
                </div>

                {/* Still scrollable: a category fits on a desktop sheet, not on a
                    phone in landscape. */}
                <div className="max-h-[min(30rem,52vh)] space-y-2 overflow-y-auto overscroll-contain pr-1">
                  {active.presets.map((preset) => {
                    // Resolved per preset, not once for the sheet: a custom preset
                    // can pin its own frame rate (and with it, its bitrate), so
                    // only the resolved values describe what this row encodes.
                    const resolved =
                      preset.kind === 'mp4'
                        ? resolveMp4Preset(preset, project, assets, { forceMaxFps })
                        : null;
                    return (
                      <button
                        key={preset.id}
                        className={`block w-full rounded-xl border p-3 text-left ${selected.id === preset.id ? 'border-sky-500 bg-sky-500/10' : 'border-zinc-700 bg-zinc-950 hover:bg-zinc-900 active:bg-zinc-800'}`}
                        onClick={() => setSelectedId(preset.id)}
                      >
                        <div className="text-sm font-medium text-zinc-100">
                          {t(preset.labelKey)}{preset.qualityKey && ` · ${t(preset.qualityKey)}`}
                        </div>
                        <div className="mt-0.5 text-xs text-zinc-400">
                          {resolved
                            ? t(resolved.descriptionKey, {
                                fps: resolved.fps,
                                width: resolved.width,
                                height: resolved.height,
                                codec: CODEC_LABELS[resolved.codec ?? 'avc'],
                                bitrate: Math.round(resolved.videoBitrate / 1_000_000),
                                audioBitrate: Math.round(resolved.audioBitrate / 1_000),
                              })
                            : t(preset.descriptionKey, {
                                bitrate: Math.round(preset.audioBitrate / 1_000),
                              })}
                        </div>
                        {preset.hintKey && (
                          <div className="mt-1 text-2xs text-zinc-500">{t(preset.hintKey)}</div>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Only where it changes the outcome: over 120 fps rushes a
                    120 fps preset already encodes at 120, and asking would be a
                    question with one answer. */}
                {selected.kind === 'mp4' && fpsCapBinds(selected, project, assets) && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-950 p-2.5 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={forceMaxFps}
                      onChange={(e) => setForceMaxFps(e.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 accent-sky-400"
                    />
                    <span>
                      {t('export.forceMaxFps', { fps: selected.fps })}
                      <span className="mt-0.5 block text-2xs text-zinc-500">
                        {t('export.forceMaxFps.hint', {
                          source: projectSourceFps(project, assets),
                        })}
                      </span>
                    </span>
                  </label>
                )}

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
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 py-3 text-sm font-semibold text-white hover:bg-sky-400 active:bg-sky-600"
                  onClick={() => run(selected)}
                >
                  <DownloadIcon className="h-4 w-4" />
                  {t(exportedRegion ? 'export.cta.region' : 'export.cta', {
                    preset: `${t(selected.labelKey)}${selected.qualityKey ? ` · ${t(selected.qualityKey)}` : ''}`,
                  })}
                </button>
                <p className="text-center text-2xs text-zinc-400">{t('export.privacy')}</p>
              </>
            )}

            {phase.kind === 'rendering' && (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 text-sm text-zinc-300">
                  <UpdateIcon className="h-4 w-4 animate-spin text-sky-400" />
                  {t('export.rendering', { pct: Math.round(phase.progress * 100) })}
                </div>
                {/* The timings caption the bar, hence the tighter spacing. */}
                <div className="space-y-1.5">
                  <div
                    className="h-2 overflow-hidden rounded-full bg-zinc-800"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(phase.progress * 100)}
                    aria-label={t('export.rendering', { pct: Math.round(phase.progress * 100) })}
                  >
                    <div
                      className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
                      style={{ width: `${phase.progress * 100}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-2xs tabular-nums text-zinc-400">
                    <span>{t('export.elapsed', { time: formatDuration(elapsedMs) })}</span>
                    <span>
                      {remainingMs === null
                        ? t('export.estimating')
                        : t('export.remaining', { time: formatRemaining(remainingMs) })}
                    </span>
                  </div>
                </div>
                {phase.fallback && (
                  <p className="text-2xs text-amber-300/90">
                    {t(`export.fallback.${phase.fallback}`)}
                  </p>
                )}
                <button
                  className="w-full rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70 active:bg-zinc-800"
                  onClick={() => {
                    canceledRef.current = true;
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
                <CheckCircledIcon className="mx-auto h-8 w-8 text-emerald-400" />
                <p className="text-sm text-zinc-200">
                  {/* The file name keeps its monospace styling, hence <Trans>. */}
                  <Trans
                    i18nKey="export.saved"
                    values={{ filename: phase.filename }}
                    components={{ name: <span className="font-mono text-xs" /> }}
                  />
                </p>
                <div className="flex gap-2">
                  {phase.blob && (
                    <button
                      className="flex-1 rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70 active:bg-zinc-800"
                      onClick={() => downloadBlob(phase.blob!, phase.filename)}
                    >
                      {t('export.downloadAgain')}
                    </button>
                  )}
                  <button
                    className="flex-1 rounded-xl bg-sky-500 py-2 text-sm font-semibold text-white hover:bg-sky-400 active:bg-sky-600"
                    onClick={() => setPhase({ kind: 'idle' })}
                  >
                    {t('export.newExport')}
                  </button>
                </div>
              </div>
            )}

            {phase.kind === 'error' && (
              <div className="space-y-3 py-2 text-center">
                <CrossCircledIcon className="mx-auto h-8 w-8 text-red-400" />
                {/* Already translated by the exporter, worker codes included. */}
                <p className="text-sm text-red-300">{phase.message}</p>
                <button
                  className="w-full rounded-xl border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70 active:bg-zinc-800"
                  onClick={() => setPhase({ kind: 'idle' })}
                >
                  {t('export.back')}
                </button>
              </div>
            )}
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}
