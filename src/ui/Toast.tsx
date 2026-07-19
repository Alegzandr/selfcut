import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check } from 'lucide-react';
import { useStore } from '../store/store';

const DISMISS_MS = 5000;

export function Toast() {
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  // One slot, two tones: raising either message clears the other in the store,
  // so at most one of the two is ever set.
  const message = error ?? notice;
  const isError = error !== null;

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => {
      const s = useStore.getState();
      if (isError) s.setError(null);
      else s.setNotice(null);
    }, DISMISS_MS);
    return () => clearTimeout(timer);
  }, [message, isError]);

  const Icon = isError ? AlertTriangle : Check;

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          role={isError ? 'alert' : 'status'}
          aria-live={isError ? 'assertive' : 'polite'}
          className={`fixed bottom-4 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-xl ${
            isError
              ? 'border-red-900 bg-red-950 text-red-200'
              : 'border-zinc-700 bg-zinc-900 text-zinc-200'
          }`}
          onClick={() => {
            const s = useStore.getState();
            if (isError) s.setError(null);
            else s.setNotice(null);
          }}
        >
          <Icon className={`h-4 w-4 flex-none ${isError ? 'text-red-400' : 'text-emerald-400'}`} />
          {/* Multi-file import failures arrive as several lines: show them all. */}
          <span className="min-w-0 whitespace-pre-line">{message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
