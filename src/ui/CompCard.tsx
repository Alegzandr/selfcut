import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EnterIcon, PlusIcon, StackIcon } from '@radix-ui/react-icons';
import type { Composition } from '../types';
import { compUsages, tracksDurationMs } from '../model';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { formatTimeShort } from '../lib/time';
import { COMP_DRAG_MIME } from '../app/config';
import { setDraggedComp } from '../timeline/dragSource';
import { compColorClass } from '../timeline/compColors';
import { useIsCoarsePointer } from '../lib/device';

/**
 * The compositions bin: precomps sit in the library beside the footage, because
 * that is what they are once they exist - a source you drop on a timeline.
 *
 * A card carries the one thing a thumbnail cannot say about a composition: how
 * many lanes are inside, how long it runs, and how many clips are currently
 * playing it. That last number is what makes a delete safe to reason about, and
 * it is the reason the section is not just a list of names.
 */
export function CompsPane() {
  const { t } = useTranslation();
  const comps = useStore((s) => s.project.comps) ?? [];
  if (comps.length === 0) return null;

  return (
    <section className="flex flex-none flex-col border-b border-zinc-800">
      <div className="flex h-7 flex-none items-center gap-1.5 px-2 text-2xs font-semibold uppercase tracking-wide text-zinc-400">
        <StackIcon className="h-3.5 w-3.5" />
        {t('comp.library')}
        <span className="font-normal text-zinc-500">{comps.length}</span>
      </div>
      {/* Same reflowing grid as the media bin, so widening the column adds
          columns of compositions exactly as it adds columns of footage. */}
      <div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(132px,1fr))] content-start gap-1.5 px-1.5 pb-1.5">
        {comps.map((comp) => (
          <CompCard key={comp.id} comp={comp} />
        ))}
      </div>
    </section>
  );
}

function CompCard({ comp }: { comp: Composition }) {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const renaming = useStore((s) => s.renamingCompId === comp.id);
  const active = useStore((s) => s.activeCompId === comp.id);
  // Counted off the live project so the badge follows a comp clip being deleted
  // or duplicated, rather than going stale the moment the library is not the
  // thing being touched.
  const uses = useStore((s) => compUsages(s.project, comp.id).length);
  const colors = compColorClass(comp.color);
  const durationMs = tracksDurationMs(comp.tracks);

  return (
    <div
      className={`group overflow-hidden rounded-md border bg-zinc-900 ${
        active ? 'border-blue-400' : 'border-zinc-800'
      }`}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(COMP_DRAG_MIME, comp.id);
        e.dataTransfer.effectAllowed = 'copy';
        // The payload is write-only until the drop, so the timeline's ghost
        // reads what is being dragged from here to know how wide to draw itself.
        setDraggedComp(comp.id, tracksDurationMs(comp.tracks));
      }}
      onDragEnd={() => setDraggedComp(null, 0)}
      onDoubleClick={() => useStore.getState().openComp(comp.id)}
      onContextMenu={(e) => {
        if (coarse) return; // Desktop only: leave the native menu on touch long-press.
        e.preventDefault();
        useStore.getState().openContextMenu(e.clientX, e.clientY, { kind: 'comp', compId: comp.id });
      }}
    >
      {/* No thumbnail: a composition has no single frame that stands for it, and
          rendering one would be a decode per card of a timeline that changes on
          every edit. The plate says what it is; the numbers say what is in it. */}
      <button
        className={`relative flex aspect-video w-full flex-col items-center justify-center gap-1 ${colors.body}`}
        onClick={() => useStore.getState().openComp(comp.id)}
        aria-label={t('comp.open')}
      >
        <StackIcon className={`h-6 w-6 ${colors.ink}`} />
        <span className="flex items-center gap-1 text-4xs uppercase tracking-wide text-white/50">
          <EnterIcon className="h-2.5 w-2.5" aria-hidden />
          {t('comp.openHint')}
        </span>
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-4xs tabular-nums text-zinc-200">
          {formatTimeShort(durationMs)}
        </span>
        <span className={`absolute left-1 top-1 h-2 w-2 rounded-full ${colors.dot}`} />
      </button>

      <div className="flex items-center gap-1 border-t border-zinc-800 bg-zinc-950/60 px-1 py-0.5 text-4xs text-zinc-500">
        <span className="truncate">{t('comp.layers', { count: comp.tracks.length })}</span>
        <span className="ml-auto flex-none">
          {uses > 0 ? t('comp.used', { count: uses }) : t('comp.unused')}
        </span>
      </div>

      <div className="flex items-center gap-1 p-1">
        {renaming ? (
          <CompNameField comp={comp} />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-3xs text-zinc-300"
            title={comp.name}
            onDoubleClick={() => useStore.getState().setRenamingComp(comp.id)}
          >
            {comp.name}
          </span>
        )}
        <Tooltip label={t('comp.add')}>
          <button
            className="touch-hit flex-none rounded p-1 brand-quiet pointer-coarse:p-2"
            onClick={() => useStore.getState().addCompClip(comp.id)}
            aria-label={t('comp.add')}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** In-place rename, with the same Enter/blur/Escape contract as everywhere else. */
function CompNameField({ comp }: { comp: Composition }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(comp.name);
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    useStore.getState().renameComp(comp.id, value);
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // The editor's hotkeys listen on the window: a name holding an S or a K
        // would split a clip and stop playback while it was being typed.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed.current = true;
          useStore.getState().setRenamingComp(null);
        }
      }}
      aria-label={t('comp.namePlaceholder')}
      className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-950 px-1 py-0.5 text-3xs text-zinc-100 outline-none focus:border-blue-400"
    />
  );
}
