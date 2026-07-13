import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useStore } from '../store/store';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Playback',
    rows: [
      ['Space', 'Play / pause'],
      ['K', 'Pause'],
      ['L', 'Play'],
      ['J', 'Step back 1s'],
    ],
  },
  {
    title: 'Navigate',
    rows: [
      ['← / →', 'Previous / next frame'],
      ['Shift + ← / →', 'Back / forward 1s'],
      ['Ctrl + ← / →', 'Previous / next cut point'],
      ['Home / End', 'Start / end of project'],
    ],
  },
  {
    title: 'Zoom & view',
    rows: [
      ['↑ / ↓  or  + / −', 'Zoom in / out at playhead'],
      ['Ctrl + wheel', 'Zoom at cursor'],
      ['Wheel', 'Pan timeline'],
      ['Alt + wheel', 'Scroll tracks vertically'],
    ],
  },
  {
    title: 'Edit',
    rows: [
      ['S', 'Split at playhead'],
      ['Del / Backspace', 'Delete selected clip'],
      ['[ / ]', 'Trim clip start / end to playhead'],
      ['Ctrl + C / X / V', 'Copy / cut / paste clip'],
      ['Ctrl + D', 'Duplicate clip'],
      ['Ctrl + Z / Y', 'Undo / redo'],
      ['Esc', 'Deselect'],
      ['?', 'Toggle this panel'],
    ],
  },
];

export function ShortcutsHelp() {
  const open = useStore((s) => s.shortcutsOpen);
  const { setShortcutsOpen } = useStore.getState();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShortcutsOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            className="max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">Keyboard shortcuts</h2>
              <button
                className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800"
                onClick={() => setShortcutsOpen(false)}
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {GROUPS.map((g) => (
                <div key={g.title}>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    {g.title}
                  </h3>
                  <dl className="space-y-1">
                    {g.rows.map(([keys, label]) => (
                      <div key={keys} className="flex items-baseline justify-between gap-3 text-xs">
                        <dt className="font-mono text-zinc-300">{keys}</dt>
                        <dd className="text-right text-zinc-500">{label}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
