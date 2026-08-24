import { useEffect, useRef, useState } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { ExclamationTriangleIcon } from '@radix-ui/react-icons';
import { eraseSelfcutData } from '../lib/resetData';
import { captionCacheAvailable, listCachedModels } from '../media/captionsCache';
import { formatBytes } from '../lib/bytes';

/**
 * The confirmation in front of the data erase.
 *
 * A dialog of its own rather than the shared `ConfirmDialog`, because this
 * decision is not a yes/no: the models are hundreds of megabytes of download
 * that hold nothing personal, so "clear my work" and "clear the transcriber"
 * are two different intentions and the user gets to separate them. A single
 * OK button would force whoever wants a clean project list to also spend
 * twenty minutes re-downloading Whisper.
 *
 * The consequences are spelled out rather than summarised. "Delete data" reads
 * as cache clearing to most people; projects and the media library are not
 * recoverable, and the copy has to say so before the button is pressed, not in
 * a toast afterwards.
 */
/** What the erase costs, spelled out one line at a time. */
const LOSSES: readonly ParseKeys[] = [
  'preferences.data.reset.item.projects',
  'preferences.data.reset.item.library',
  'preferences.data.reset.item.settings',
];

export function ResetDataDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [keepModels, setKeepModels] = useState(true);
  const [modelBytes, setModelBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Measure what the models occupy, so the option can say what keeping them is
  // worth. Absent (or zero) and the choice is not offered at all - an empty
  // checkbox is one more thing to read for no decision.
  useEffect(() => {
    if (!open || !captionCacheAvailable()) return;
    let live = true;
    void listCachedModels().then((cached) => {
      if (!live) return;
      let total = 0;
      for (const { bytes } of cached.values()) total += bytes;
      setModelBytes(total);
    });
    return () => {
      live = false;
    };
  }, [open]);

  // Escape cancels, and the cancelling button takes focus: the destructive
  // action is never one stray Enter away.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  const offerModels = modelBytes !== null && modelBytes > 0;

  async function erase() {
    setBusy(true);
    // Reload whatever happens. The erase is best-effort by construction (a
    // second tab can hold the database, private mode can refuse storage), and
    // leaving the editor running on state whose backing store is gone is the
    // one outcome worse than an incomplete wipe.
    try {
      await eraseSelfcutData({ keepModels: offerModels && keepModels });
    } catch (err) {
      console.warn('[reset] erase failed:', err);
    }
    location.reload();
  }

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={() => !busy && onClose()}
        >
          <m.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="alertdialog"
            aria-modal="true"
            aria-label={t('preferences.data.reset.title')}
            className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-red-500/15">
                <ExclamationTriangleIcon className="h-4 w-4 text-red-300" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">
                  {t('preferences.data.reset.title')}
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  {t('preferences.data.reset.body')}
                </p>
                <ul className="mt-3 space-y-1 text-xs text-zinc-300">
                  {LOSSES.map((key) => (
                    <li key={key} className="flex gap-2">
                      <span aria-hidden className="text-red-400">
                        ·
                      </span>
                      {t(key)}
                    </li>
                  ))}
                </ul>
                {/* The one genuinely reassuring fact, and the one people ask
                    about first: the originals are referenced, never copied. */}
                <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
                  {t('preferences.data.reset.safe')}
                </p>
              </div>
            </div>

            {offerModels && (
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 flex-none accent-sky-500"
                  checked={keepModels}
                  onChange={(e) => setKeepModels(e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-xs text-zinc-200">
                    {t('preferences.data.reset.keepModels', {
                      size: formatBytes(modelBytes),
                    })}
                  </span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-zinc-500">
                    {t('preferences.data.reset.keepModels.hint')}
                  </span>
                </span>
              </label>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                onClick={onClose}
              >
                {t('confirm.cancel')}
              </button>
              <button
                disabled={busy}
                className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/30 disabled:opacity-50"
                onClick={() => void erase()}
              >
                {busy
                  ? t('preferences.data.reset.working')
                  : t('preferences.data.reset.confirm')}
              </button>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
