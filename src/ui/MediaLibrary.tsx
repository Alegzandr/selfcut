import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Film, FolderOpen, Image, Music, Plus, PlugZap, Trash2, X } from 'lucide-react';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { MediaAsset } from '../types';
import { formatTimeShort } from '../lib/time';
import { ASSET_DRAG_MIME } from '../app/config';
import { useIsCoarsePointer } from '../lib/device';
import { openMediaPicker } from './mediaPicker';

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

/**
 * Prompt for a replacement file and reconnect the given asset to it. Used both
 * on the card and from the restore banner (the file dialog only surfaces the
 * OS file, so the match is the user's responsibility).
 */
export function reconnectAssetViaPicker(assetId: string): void {
  openMediaPicker((files) => {
    const file = files[0];
    if (file) void useStore.getState().reconnectAsset(assetId, file);
  });
}

function AssetCard({ asset }: { asset: MediaAsset }) {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const { addClipFromAsset, removeAsset } = useStore.getState();
  const hasThumbnail = asset.thumbnails.length > 0;
  const disconnected = asset.disconnected;

  return (
    <div
      className={`group overflow-hidden rounded-md border bg-zinc-900 ${
        disconnected ? 'border-amber-500/60' : 'border-zinc-800'
      }`}
      draggable={!disconnected}
      onDragStart={(e) => {
        // Desktop: drag the asset straight onto a timeline position.
        e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onContextMenu={(e) => {
        if (coarse) return; // Desktop only.
        e.preventDefault();
        useStore.getState().openContextMenu(e.clientX, e.clientY, {
          kind: 'asset',
          assetId: asset.id,
        });
      }}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-950">
        {hasThumbnail ? (
          <img
            src={asset.thumbnails[0]}
            className={`h-full w-full object-cover ${disconnected ? 'opacity-40' : ''}`}
            alt=""
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-emerald-900/50 to-emerald-950">
            <Music className={`h-6 w-6 text-emerald-300 ${disconnected ? 'opacity-40' : ''}`} />
          </div>
        )}
        {disconnected && (
          <button
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-950/60 text-amber-300"
            onClick={() => reconnectAssetViaPicker(asset.id)}
            title={t('library.reconnect')}
          >
            <PlugZap className="h-5 w-5" />
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
              {t('library.disconnected')}
            </span>
          </button>
        )}
        {/* A still has no intrinsic duration - a time badge would only mislead. */}
        {asset.kind !== 'image' && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] tabular-nums text-zinc-200">
            {formatTimeShort(asset.durationMs)}
          </span>
        )}
        <span className="absolute left-1 top-1 rounded bg-black/70 p-0.5 text-zinc-300">
          {asset.kind === 'video' ? (
            <Film className="h-3 w-3" />
          ) : asset.kind === 'image' ? (
            <Image className="h-3 w-3" />
          ) : (
            <Music className="h-3 w-3" />
          )}
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
        {disconnected ? (
          <Tooltip label={t('library.reconnect')}>
            <button
              className="flex-none rounded bg-amber-500/15 p-1 text-amber-300 active:bg-amber-500/30"
              onClick={() => reconnectAssetViaPicker(asset.id)}
            >
              <PlugZap className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : (
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
        )}
      </div>
    </div>
  );
}
