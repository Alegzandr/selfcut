import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  Film,
  FolderOpen,
  Image,
  Import,
  Music,
  Plus,
  PlugZap,
  Trash2,
  X,
} from 'lucide-react';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { MediaAsset } from '../types';
import { formatTimeShort } from '../lib/time';
import { ASSET_DRAG_MIME, LIBRARY_WIDTH_PX } from '../app/config';
import { useIsCoarsePointer } from '../lib/device';
import { ResizeHandle } from './ResizeHandle';
import { openMediaPicker } from './mediaPicker';
import { audioKey } from '../media/mediaCache';
import { useImport } from './useImport';

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
  const libraryWidthPx = useStore((s) => s.libraryWidthPx);
  const importFiles = useImport();
  const list = Object.values(assets);
  const importHere = () => openMediaPicker(importFiles);

  const body = (
    <>
      <div className="flex h-8 flex-none items-center gap-1.5 border-b border-zinc-800 px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        <FolderOpen className="h-3.5 w-3.5" />
        {t('library.title')}
        {/* Bare count badge: no unit to translate, but it needs a spoken label. */}
        <div className="ml-auto flex items-center gap-0.5">
          {list.length > 0 && (
            <span
              className="font-normal text-zinc-400"
              aria-label={t('library.count', { count: list.length })}
            >
              {list.length}
            </span>
          )}
          {/* Always reachable: once the library holds assets, this is the only
              import entry point in reach - the timeline dropzone is gone. */}
          <Tooltip label={t('library.import')}>
            <button
              className="touch-hit rounded bg-sky-500/15 p-1 text-sky-300 hover:bg-sky-500/25 active:bg-sky-500/30 pointer-coarse:p-2"
              onClick={importHere}
              aria-label={t('library.import')}
            >
              <Import className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {coarse && (
            <button
              className="touch-hit -mr-1 rounded p-1 text-zinc-400 active:bg-zinc-800 pointer-coarse:p-2"
              onClick={() => useStore.getState().setLibraryOpen(false)}
              title={t('library.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <p className="p-3 text-[11px] leading-relaxed text-zinc-400">{t('library.empty')}</p>
      ) : (
        // Reflowing grid rather than a stack: widening the column adds columns
        // of cards instead of inflating one card, so the extra room buys more
        // visible assets. `auto-fill` + `1fr` lets the tiles share the leftover
        // width evenly, and `content-start` keeps a half-empty bin top-aligned.
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(132px,1fr))] content-start gap-1.5 overflow-y-auto p-1.5">
          {list.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </>
  );

  if (!coarse) {
    return (
      // The handle is a sibling, not a child: it has to sit in the same flex row
      // as the column so it can straddle the border without being clipped.
      <>
        <aside
          className="flex flex-none flex-col overflow-hidden border-r border-zinc-800 bg-zinc-900/60"
          style={{ width: libraryWidthPx }}
        >
          {body}
        </aside>
        <ResizeHandle
          width={libraryWidthPx}
          onWidth={useStore.getState().setLibraryWidthPx}
          defaultWidth={LIBRARY_WIDTH_PX}
        />
      </>
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

/**
 * One row per audio track the browser cannot decode, offering to transcode it.
 *
 * Deliberately explicit about the cost: the first activation pulls a 32 MB
 * converter and then chews through the whole file, which is long enough that an
 * unexplained spinner would read as a freeze.
 */
function UndecodableAudio({ asset }: { asset: MediaAsset }) {
  const { t } = useTranslation();
  const transcodes = useStore((s) => s.transcodes);
  const pending = asset.audioTracks.filter((track) => track.undecodable && !track.transcoded);
  if (pending.length === 0 || asset.disconnected) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/60 px-1 py-1">
      {pending.map((track) => {
        const key = audioKey(asset.id, track.index);
        const progress = transcodes[key];
        const running = progress != null;
        const name =
          track.label ??
          track.language ??
          t('library.audio.trackNumber', { n: track.index + 1 });
        return (
          <div key={track.index} className="flex items-center gap-1">
            <span
              className="min-w-0 flex-1 truncate text-[9px] text-amber-300/90"
              title={t('library.audio.needsTranscode', { codec: track.codec ?? '?' })}
            >
              {running
                ? t('library.audio.converting', { percent: Math.round(progress * 100) })
                : `${name} · ${track.codec ?? '?'}`}
            </span>
            {running ? (
              <button
                className="touch-hit flex-none rounded px-1 py-0.5 text-[9px] text-zinc-400 active:bg-zinc-800 pointer-coarse:p-2"
                onClick={() => useStore.getState().cancelTranscode(asset.id, track.index)}
              >
                {t('library.audio.cancel')}
              </button>
            ) : (
              <Tooltip label={t('library.audio.activateHint')}>
                <button
                  className="touch-hit flex-none rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300 active:bg-amber-500/30 pointer-coarse:p-2"
                  onClick={() => void useStore.getState().transcodeAudioTrack(asset.id, track.index)}
                >
                  <AudioLines className="mr-0.5 inline h-3 w-3" />
                  {t('library.audio.activate')}
                </button>
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
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

      <UndecodableAudio asset={asset} />

      <div className="flex items-center gap-1 p-1">
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300" title={asset.file.name}>
          {asset.file.name}
        </span>
        <Tooltip label={t('library.remove')}>
          <button
            className="touch-hit flex-none rounded p-1 text-zinc-400 active:bg-zinc-800 active:text-red-400 pointer-coarse:p-2"
            onClick={() => removeAsset(asset.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        {disconnected ? (
          <Tooltip label={t('library.reconnect')}>
            <button
              className="touch-hit flex-none rounded bg-amber-500/15 p-1 text-amber-300 active:bg-amber-500/30 pointer-coarse:p-2"
              onClick={() => reconnectAssetViaPicker(asset.id)}
            >
              <PlugZap className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label={t('library.add')}>
            <button
              className="touch-hit flex-none rounded bg-sky-500/15 p-1 text-sky-300 active:bg-sky-500/30 pointer-coarse:p-2"
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
