import { Film, FolderOpen, Music, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../store/store';
import { MediaAsset } from '../types';
import { formatTimeShort } from '../lib/time';

/**
 * Source explorer: every imported file lands here. From here assets are
 * placed on the timeline (append to the first matching track) or removed
 * (which also removes their clips).
 */
export function MediaLibrary() {
  const assets = useStore((s) => s.assets);
  const list = Object.values(assets);

  return (
    <aside className="flex w-36 flex-none flex-col border-r border-zinc-800 bg-zinc-900/60 md:w-56">
      <div className="flex h-8 flex-none items-center gap-1.5 border-b border-zinc-800 px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        <FolderOpen className="h-3.5 w-3.5" />
        Media
        {list.length > 0 && <span className="ml-auto font-normal text-zinc-500">{list.length}</span>}
      </div>

      {list.length === 0 ? (
        <p className="p-3 text-[11px] leading-relaxed text-zinc-500">
          Imported files appear here. Use Import or drop files anywhere.
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
          {list.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </aside>
  );
}

function AssetCard({ asset }: { asset: MediaAsset }) {
  const { addClipFromAsset, removeAsset } = useStore.getState();
  const isVideo = asset.kind === 'video';

  return (
    <div className="group overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
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
        <button
          className="flex-none rounded p-1 text-zinc-500 active:bg-zinc-800 active:text-red-400"
          title="Remove from library"
          onClick={() => removeAsset(asset.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex-none rounded bg-sky-500/15 p-1 text-sky-300 active:bg-sky-500/30"
          title="Add to timeline"
          onClick={() => addClipFromAsset(asset.id)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
