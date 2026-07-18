import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../store/store';

export function Toast() {
  const error = useStore((s) => s.error);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => useStore.getState().setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  return (
    <AnimatePresence>
      {error && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          role="alert"
          aria-live="assertive"
          className="fixed bottom-4 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-xl border border-red-900 bg-red-950 px-4 py-2.5 text-sm text-red-200 shadow-xl"
          onClick={() => useStore.getState().setError(null)}
        >
          <AlertTriangle className="h-4 w-4 flex-none text-red-400" />
          {/* Multi-file import failures arrive as several lines: show them all. */}
          <span className="min-w-0 whitespace-pre-line">{error}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
