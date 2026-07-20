import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../store/store';

/**
 * The app's confirmation dialog, driven by `requestConfirm()`. One instance
 * mounted at the root serves every caller, so nothing in the editor has to
 * fall back to a native `confirm()` - which looks foreign, blocks the main
 * thread (stalling playback and decoding), and is silently suppressed by
 * browsers when a page opens too many of them.
 */
export function ConfirmDialog() {
  const { t } = useTranslation();
  const request = useStore((s) => s.confirmDialog);
  const { resolveConfirm } = useStore.getState();
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Escape declines. Capture phase so the global editor hotkeys never see the
  // keystroke while the dialog owns the screen.
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      resolveConfirm(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Focus the accepting button so Enter answers and Tab stays in the dialog.
  useEffect(() => {
    if (request) confirmRef.current?.focus();
  }, [request]);

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => resolveConfirm(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="alertdialog"
            aria-modal="true"
            aria-label={request.title}
            className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-zinc-100">{request.title}</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">{request.message}</p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                onClick={() => resolveConfirm(false)}
              >
                {t('confirm.cancel')}
              </button>
              <button
                ref={confirmRef}
                className={
                  'rounded-lg px-3 py-1.5 text-xs font-semibold ' +
                  (request.danger
                    ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
                    : 'bg-zinc-100 text-zinc-900 hover:bg-white')
                }
                onClick={() => resolveConfirm(true)}
              >
                {request.confirmLabel ?? t('confirm.continue')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
