import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { useEnterMotion } from './motion';
import { useStore } from '../store/store';
import { useModalDialog } from './useModalDialog';

/**
 * The app's confirmation dialog, driven by `requestConfirm()`. One instance
 * mounted at the root serves every caller, so nothing in the editor has to
 * fall back to a native `confirm()` - which looks foreign, blocks the main
 * thread (stalling playback and decoding), and is silently suppressed by
 * browsers when a page opens too many of them.
 */
export function ConfirmDialog() {
  const { t } = useTranslation();
  const dialog = useEnterMotion({ y: 8, scale: 0.96 });
  const request = useStore((s) => s.confirmDialog);
  const { resolveConfirm } = useStore.getState();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  // Escape declines; the accepting button takes focus so Enter answers.
  useModalDialog(request !== null, panelRef, {
    onEscape: () => resolveConfirm(false),
    initialFocus: confirmRef,
  });

  return (
    <AnimatePresence>
      {request && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => resolveConfirm(false)}
        >
          <m.div
            ref={panelRef}
            {...dialog}
            role="alertdialog"
            aria-modal="true"
            aria-label={request.title}
            className="w-full max-w-sm sheet p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="title-display text-sm text-zinc-50">{request.title}</h2>
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
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
