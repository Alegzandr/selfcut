import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import logoUrl from '../assets/logo.png';
import { APP_NAME, APP_VERSION } from '../app/config';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';

/**
 * About dialog, opened from Help. A small identity card: logo, name, version
 * and a one-line description of what the app is.
 */
export function About() {
  const { t } = useTranslation();
  const open = useStore((s) => s.aboutOpen);
  const { setAboutOpen } = useStore.getState();

  // Escape closes the dialog (the tooltip advertises it); capture phase so the
  // global editor hotkeys never see the keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAboutOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setAboutOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="dialog"
            aria-modal="true"
            aria-label={t('menu.help.about')}
            className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">{t('menu.help.about')}</h2>
              <Tooltip label={t('about.close')} shortcut="Esc">
                <button
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
                  onClick={() => setAboutOpen(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <img src={logoUrl} alt="" className="h-14 w-14 select-none" draggable={false} />
              <div>
                <div className="text-lg font-bold tracking-wide text-zinc-100">{APP_NAME}</div>
                <div className="text-xs text-zinc-400">
                  {t('about.version')} {APP_VERSION}
                </div>
              </div>
              <p className="max-w-xs text-xs leading-relaxed text-zinc-400">
                {t('about.tagline')}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
