import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import {
  CheckCircledIcon,
  Cross2Icon,
  DownloadIcon,
  LightningBoltIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { Tooltip } from './Tooltip';
import { CAPTION_MODELS, type CaptionModelInfo } from '../media/captionsModel';
import {
  captionCapabilities,
  captionFit,
  captionModelSizeMb,
  type CaptionCapabilities,
  type CaptionFit,
} from '../media/captionsCapabilities';
import {
  captionCacheAvailable,
  deleteCachedModel,
  listCachedModels,
  type CachedModel,
} from '../media/captionsCache';
import {
  cancelCaptionModelDownload,
  startCaptionModelDownload,
  useCaptionModelDownload,
} from '../media/captionModelJob';
import { formatBytes } from '../lib/bytes';

/**
 * The caption model manager: which Whisper model transcribes, what it costs on
 * THIS machine, and what is already downloaded.
 *
 * Two things justify a dialog of its own rather than a dropdown in the panel.
 * The choice is a trade the user cannot make blind - a model that is excellent
 * on a GPU laptop is unusable on a machine without one, and the download ranges
 * from 150 MB to most of a gigabyte. And once downloaded, those megabytes sit in
 * the browser's storage forever unless something offers to hand them back, which
 * a picker with no delete button never does.
 */

const FIT_STYLE: Record<CaptionFit, string> = {
  recommended: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  usable: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
  slow: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  unsupported: 'border-zinc-700 bg-zinc-800/40 text-zinc-500',
};

/** Four segments, filled to the model's rank: a size in MB does not say "better". */
function QualityBars({ level }: { level: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`h-2.5 w-1 rounded-full ${i <= level ? 'bg-brand-500' : 'bg-zinc-700'}`}
        />
      ))}
    </span>
  );
}

function ModelRow({
  model,
  caps,
  cached,
  active,
  downloading,
  busy,
  onSelect,
  onDownload,
  onCancel,
  onDelete,
}: {
  model: CaptionModelInfo;
  caps: CaptionCapabilities | null;
  cached: CachedModel | undefined;
  active: boolean;
  downloading: number | null;
  /** Another row is downloading: only one model is fetched at a time. */
  busy: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const fit = caps ? captionFit(model, caps) : 'usable';
  const unsupported = fit === 'unsupported';
  // What THIS machine downloads: a phone fetches half-precision weights, and
  // quoting the desktop figure would promise twice the wait it will have.
  const size = caps ? captionModelSizeMb(model, caps) : model.sizeMb.wasm;

  return (
    <li>
      <label
        className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
          active
            ? 'border-brand-500/70 bg-brand-500/10'
            : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
        } ${unsupported ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <input
          type="radio"
          name="caption-model"
          className="mt-0.5 h-4 w-4 flex-none accent-brand-500"
          checked={active}
          disabled={unsupported}
          onChange={onSelect}
          aria-label={model.name}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-zinc-100">{model.name}</span>
            <QualityBars level={model.quality} />
            <span className={`rounded-full border px-1.5 py-px text-2xs ${FIT_STYLE[fit]}`}>
              {t(`captions.models.fit.${fit}`)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-2xs text-zinc-500">
            {cached ? (
              <>
                <CheckCircledIcon className="h-3 w-3 flex-none text-emerald-400" />
                {/* Measured, not advertised: the estimate is what the row shows
                    before a download, and the truth once there is one. */}
                <span>{t('captions.models.downloaded', { size: formatBytes(cached.bytes) })}</span>
              </>
            ) : unsupported ? (
              // Quoting a download size for a model this machine cannot run
              // would answer a question nobody asked; say why instead.
              <span>{t(model.gpuOnly ? 'captions.models.needsGpu' : 'captions.models.tooBig')}</span>
            ) : (
              <span>{t('captions.models.size', { size: `~${size} MB` })}</span>
            )}
          </div>
          {downloading != null && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-brand-500 transition-[width]"
                  style={{ width: `${Math.round(downloading * 100)}%` }}
                />
              </div>
              <span className="whitespace-nowrap tabular-nums text-2xs text-zinc-400">
                {Math.round(downloading * 100)} %
              </span>
              {/* The way out has to be here, on the row: the download no longer
                  dies when the dialog closes, so closing is not cancelling. */}
              <button
                type="button"
                className="touch-hit flex-none rounded px-1 py-0.5 text-2xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={onCancel}
              >
                {t('library.job.cancel')}
              </button>
            </div>
          )}
        </div>
        {!unsupported && downloading == null && (
          <div className="flex flex-none items-center gap-1">
            {cached ? (
              <Tooltip label={t('captions.models.delete')}>
                <button
                  type="button"
                  className="touch-hit rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  onClick={onDelete}
                  aria-label={t('captions.models.delete')}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label={t('captions.models.download')}>
                <button
                  type="button"
                  className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-30"
                  disabled={busy}
                  onClick={onDownload}
                  aria-label={t('captions.models.download')}
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </label>
    </li>
  );
}

export function CaptionModelDialog({
  open,
  model,
  onPick,
  onClose,
}: {
  open: boolean;
  model: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [caps, setCaps] = useState<CaptionCapabilities | null>(null);
  const [cache, setCache] = useState<Map<string, CachedModel> | null>(null);
  // The download outlives this dialog (see `captionModelJob`), so it is read
  // rather than owned: reopening the manager finds the run still going.
  const downloading = useCaptionModelDownload();

  const refreshCache = useCallback(() => {
    if (!captionCacheAvailable()) return;
    void listCachedModels().then(setCache);
  }, []);

  useEffect(() => {
    if (!open) return;
    void captionCapabilities().then(setCaps);
    refreshCache();
  }, [open, refreshCache]);

  // Escape closes; capture phase so the global editor hotkeys never see it while
  // the dialog owns the screen.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Deliberately no abort on close: a download of several hundred megabytes is
  // exactly the thing to start and then go back to cutting over. It keeps
  // running, this dialog picks it back up on reopen, and the row it sits on
  // carries the cancel button for anyone who does want it stopped.

  const download = (id: string) => {
    startCaptionModelDownload(id, refreshCache);
  };

  const remove = (info: CaptionModelInfo) => {
    void deleteCachedModel(info).then(refreshCache);
  };

  const backend = caps
    ? caps.device === 'webgpu'
      ? t('captions.models.backend.gpu', { adapter: caps.adapter ?? t('captions.models.backend.gpuGeneric') })
      : t('captions.models.backend.cpu')
    : t('captions.models.backend.probing');

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4"
          onClick={onClose}
        >
          <m.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="dialog"
            aria-modal="true"
            aria-label={t('captions.models.title')}
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <h2 className="min-w-0 text-sm font-semibold text-zinc-100">
                {t('captions.models.title')}
              </h2>
              <Tooltip label={t('library.tracks.close')} shortcut="Esc">
                <button
                  className="touch-hit -mt-1 flex-none rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
                  onClick={onClose}
                  aria-label={t('library.tracks.close')}
                >
                  <Cross2Icon className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            <p className="text-xs leading-relaxed text-zinc-400">{t('captions.models.hint')}</p>

            {/* The machine's own verdict, stated once at the top: every badge
                below is relative to this line. */}
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <LightningBoltIcon
                className={`h-3.5 w-3.5 flex-none ${caps?.device === 'webgpu' ? 'text-emerald-400' : 'text-zinc-500'}`}
              />
              <span className="min-w-0 flex-1 truncate text-2xs text-zinc-400">{backend}</span>
            </div>

            <ul className="-mr-2 mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-2">
              {CAPTION_MODELS.map((info) => (
                <ModelRow
                  key={info.id}
                  model={info}
                  caps={caps}
                  cached={cache?.get(info.id)}
                  active={info.id === model}
                  downloading={downloading?.id === info.id ? downloading.value : null}
                  busy={downloading != null}
                  onSelect={() => onPick(info.id)}
                  onDownload={() => download(info.id)}
                  onCancel={cancelCaptionModelDownload}
                  onDelete={() => remove(info)}
                />
              ))}
            </ul>

            <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
              {t('captions.models.privacy')}
            </p>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
