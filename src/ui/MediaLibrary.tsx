import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Film, FolderOpen, Music, Plus, Trash2, X } from 'lucide-react';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { MediaAsset } from '../types';
import { formatTimeShort } from '../lib/time';
import { ASSET_DRAG_MIME } from '../app/config';
import { useIsCoarsePointer } from '../lib/device';

/**
 * Source explorer: every imported file lands here. From here assets are
 * placed on the timeline (append to the first matching track) or removed
 * (which also removes their clips). Desktop: docked column. Mobile: a
 * drawer (screen space goes to the preview and the timeline).
 */
export function MediaLibrary() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const coarse = useIsCoarsePointer();
  const libraryOpen = useStore((s) => s.libraryOpen);
  const list = Object.values(assets);

  const body = (
    <>
      <div className="flex h-8 flex-none items-center gap-1.5 border-b border-zinc-800 px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        <FolderOpen className="h-3.5 w-3.5" />
        {t('library.title')}
        {/* Bare count badge: no unit to translate, but it needs a spoken label. */}
        {list.length > 0 && (
          <span
            className="ml-auto font-normal text-zinc-500"
            aria-label={t('library.count', { count: list.length })}
          >
            {list.length}
          </span>
        )}
        {coarse && (
          <button
            className="-mr-1 rounded p-1 text-zinc-400 active:bg-zinc-800"
            onClick={() => useStore.getState().setLibraryOpen(false)}
            title={t('library.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <p className="p-3 text-[11px] leading-relaxed text-zinc-500">{t('library.empty')}</p>
      ) : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
          {list.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </>
  );

  if (!coarse) {
    return (
      <aside className="flex w-56 flex-none flex-col border-r border-zinc-800 bg-zinc-900/60">
        {body}
      </aside>
    );
  }

  return (
    <AnimatePresence>
      {libraryOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => useStore.getState().setLibraryOpen(false)}
          />
          <motion.aside
            initial={{ x: '-105%' }}
            animate={{ x: 0 }}
            exit={{ x: '-105%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 380 }}
            className="fixed inset-y-0 left-0 z-40 flex w-44 flex-col border-r border-zinc-800 bg-zinc-900 pt-[env(safe-area-inset-top)] shadow-2xl shadow-black"
          >
            {body}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function AssetCard({ asset }: { asset: MediaAsset }) {
  const { t } = useTranslation();
  const { addClipFromAsset, removeAsset } = useStore.getState();
  const isVideo = asset.kind === 'video';

  return (
    <div
      className="group overflow-hidden rounded-md border border-zinc-800 bg-zinc-900"
      draggable
      onDragStart={(e) => {
        // Desktop: drag the asset straight onto a timeline position.
        e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-950">
        {isVideo && asset.thumbnails.length ? (
          <img src={asset.thumbnails[0]} className="h-full w-full object-cover" alt="" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-emerald-900/50 to-emerald-950">
            <Music className="h-6 w-6 text-emerald-300" />
          </div>
        )}
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] tabular-nums text-zinc-200">
          {formatTimeShort(asset.durationMs)}
        </span>
        <span className="absolute left-1 top-1 rounded bg-black/70 p-0.5 text-zinc-300">
          {isVideo ? <Film className="h-3 w-3" /> : <Music className="h-3 w-3" />}
        </span>
      </div>

      <div className="flex items-center gap-1 p-1">
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300" title={asset.file.name}>
          {asset.file.name}
        </span>
        <Tooltip label={t('library.remove')}>
          <button
            className="flex-none rounded p-1 text-zinc-500 active:bg-zinc-800 active:text-red-400"
            onClick={() => removeAsset(asset.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip label={t('library.add')}>
        <button
          className="flex-none rounded bg-sky-500/15 p-1 text-sky-300 active:bg-sky-500/30"
          onClick={() => {
            addClipFromAsset(asset.id);
            // Mobile drawer: close it so the freshly placed clip is visible.
            useStore.getState().setLibraryOpen(false);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        </Tooltip>
      </div>
    </div>
  );
}
