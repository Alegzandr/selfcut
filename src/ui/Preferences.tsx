import { useEffect, type ReactNode } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import i18n, { LOCALES, type Locale } from '../i18n';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import type { TimeFormat } from '../lib/time';

const TIME_FORMATS: readonly { value: TimeFormat; labelKey: ParseKeys }[] = [
  { value: 'timecode', labelKey: 'preferences.timeFormat.timecode' },
  { value: 'decimal', labelKey: 'preferences.timeFormat.decimal' },
];

const SELECT_CLASS =
  'min-w-44 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500';

/** One labelled preference row: description on the left, control on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-xs text-zinc-300">{label}</span>
      {children}
    </div>
  );
}

/**
 * Preferences dialog, opened from the desktop menu bar. Holds the settings that
 * are meaningful for A/V editing and safe to expose without an "advanced" gate:
 * the interface language and how the transport spells time out.
 */
export function Preferences() {
  const { t } = useTranslation();
  const open = useStore((s) => s.preferencesOpen);
  const timeFormat = useStore((s) => s.timeFormat);
  const { setPreferencesOpen, setTimeFormat } = useStore.getState();
  const currentLang = (i18n.resolvedLanguage ?? 'en') as Locale;

  // Escape closes the dialog (the tooltip advertises it); capture phase so the
  // global editor hotkeys never see the keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPreferencesOpen(false);
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
          onClick={() => setPreferencesOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="dialog"
            aria-modal="true"
            aria-label={t('preferences.title')}
            className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">{t('preferences.title')}</h2>
              <Tooltip label={t('preferences.close')} shortcut="Esc">
                <button
                  className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
                  onClick={() => setPreferencesOpen(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            <div className="divide-y divide-zinc-800">
              <Row label={t('topbar.language')}>
                <select
                  className={SELECT_CLASS}
                  aria-label={t('a11y.preferences.language')}
                  value={currentLang}
                  onChange={(e) => void i18n.changeLanguage(e.target.value)}
                >
                  {(Object.keys(LOCALES) as Locale[]).map((code) => (
                    <option key={code} value={code}>
                      {LOCALES[code]}
                    </option>
                  ))}
                </select>
              </Row>

              <Row label={t('preferences.timeFormat')}>
                <select
                  className={SELECT_CLASS}
                  aria-label={t('a11y.preferences.timeFormat')}
                  value={timeFormat}
                  onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
                >
                  {TIME_FORMATS.map(({ value, labelKey }) => (
                    <option key={value} value={value}>
                      {t(labelKey)}
                    </option>
                  ))}
                </select>
              </Row>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
