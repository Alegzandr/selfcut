import { AnimatePresence, motion } from 'framer-motion';
import { Copy, Scissors, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useStore, getSelectedClip } from '../store/store';
import { useIsCoarsePointer } from '../lib/device';

/** Mobile contextual toolbar (CapCut-style): appears when a clip is selected. */
export function ClipActionBar() {
  const coarse = useIsCoarsePointer();
  const clip = useStore(getSelectedClip);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const show = coarse && clip !== null && !inspectorOpen;

  const item =
    'flex min-w-14 flex-col items-center gap-1 rounded-lg px-3 py-1.5 text-[10px] text-zinc-300 active:bg-zinc-800';

  return (
    <AnimatePresence>
      {show && clip && (
        <motion.div
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 380 }}
          className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-zinc-800 bg-zinc-900/95 px-2 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur"
        >
          <button className={item} onClick={() => useStore.getState().splitAtPlayhead()}>
            <Scissors className="h-5 w-5" />
            Split
          </button>
          <button className={item} onClick={() => useStore.getState().duplicateClip(clip.id)}>
            <Copy className="h-5 w-5" />
            Duplicate
          </button>
          <button className={item} onClick={() => useStore.getState().setInspectorOpen(true)}>
            <SlidersHorizontal className="h-5 w-5" />
            Adjust
          </button>
          <button className={item} onClick={() => useStore.getState().deleteClip(clip.id)}>
            <Trash2 className="h-5 w-5" />
            Delete
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
