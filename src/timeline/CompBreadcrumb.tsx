import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ChevronRightIcon,
  ExitIcon,
  HomeIcon,
  Pencil1Icon,
  StackIcon,
} from '@radix-ui/react-icons';
import { useStore, getActiveComp } from '../store/store';
import { compPath, tracksDurationMs } from '../model';
import { formatTimeShort } from '../lib/time';
import { useEnterMotion } from '../ui/motion';
import { compColorClass } from './compColors';
import { Tooltip } from '../ui/Tooltip';
import { useIsCoarsePointer } from '../lib/device';

/**
 * The trail from the main timeline down to the composition being edited, and
 * the only way back up.
 *
 * Opening a precomp replaces the whole timeline - its lanes, its clips, its
 * markers, its length. That is the point of it, and it is also the one thing
 * that could leave someone lost, so the trail is not decoration: it is the
 * answer to "where am I" and "how do I get out", and it earns its row of pixels
 * only while the answer is not obvious. At the main timeline it renders nothing
 * at all.
 *
 * The current step is editable in place (double-click, or the pencil), because
 * a composition is named at the moment it is created - which is the moment
 * nobody yet knows what to call it.
 */
export function CompBreadcrumb() {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const project = useStore((s) => s.project);
  const activeCompId = useStore((s) => s.activeCompId);
  const comp = useStore(getActiveComp);
  const renaming = useStore((s) => s.renamingCompId === activeCompId && activeCompId !== null);

  const trail = useMemo(
    () => compPath(project, activeCompId, t('comp.mainTimeline')),
    [project, activeCompId, t],
  );

  // Slides down from under the toolbar above it: the strip is a thing that
  // ARRIVED when you stepped in, not a thing that was always there.
  const enter = useEnterMotion({ y: -8, opacity: 0 });

  const colors = compColorClass(comp?.color);
  const layers = comp?.tracks.length ?? 0;
  const durationMs = comp ? tracksDurationMs(comp.tracks) : 0;
  const up = () => {
    const parent = trail[trail.length - 2];
    useStore.getState().openComp(parent ? parent.compId : null);
  };

  return (
    <AnimatePresence>
      {activeCompId !== null && (
        <m.nav
          {...enter}
          transition={{ type: 'spring', damping: 30, stiffness: 420 }}
          aria-label={t('comp.breadcrumb')}
          className="flex h-8 flex-none items-center gap-1 overflow-hidden border-b border-zinc-800 bg-zinc-900/80 px-1.5"
        >
          <Tooltip label={t('comp.up')} shortcut={coarse ? undefined : 'Esc'}>
            <button
              className="touch-hit flex-none rounded p-1 text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100 pointer-coarse:p-2"
              onClick={up}
              aria-label={t('comp.up')}
            >
              <ExitIcon className="h-3.5 w-3.5 rotate-180" />
            </button>
          </Tooltip>

          {/* The trail scrolls on its own rather than squeezing the readout:
              five levels deep is rare, and when it happens the deepest steps are
              the ones worth keeping in view, so it is pinned to its end. */}
          <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {trail.map((crumb, i) => {
              const last = i === trail.length - 1;
              const crumbColors = compColorClass(crumb.color);
              return (
                <li key={crumb.compId ?? 'root'} className="flex min-w-0 flex-none items-center gap-1">
                  {i > 0 && (
                    <ChevronRightIcon className="h-3 w-3 flex-none text-zinc-600" aria-hidden />
                  )}
                  {last && renaming ? (
                    <CompNameField compId={crumb.compId!} name={crumb.name} />
                  ) : (
                    <button
                      className={`touch-hit flex min-w-0 items-center gap-1.5 rounded border px-1.5 py-0.5 text-2xs font-medium pointer-coarse:py-1.5 ${
                        last
                          ? crumbColors.chip
                          : 'border-transparent text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'
                      }`}
                      // The step you are on is not a link to itself: it is the
                      // handle that renames it.
                      onClick={() => {
                        if (!last) useStore.getState().openComp(crumb.compId);
                      }}
                      onDoubleClick={() => {
                        if (last && crumb.compId) useStore.getState().setRenamingComp(crumb.compId);
                      }}
                      aria-current={last ? 'page' : undefined}
                    >
                      {crumb.compId === null ? (
                        <HomeIcon className="h-3 w-3 flex-none" />
                      ) : (
                        <span className={`h-2 w-2 flex-none rounded-full ${crumbColors.dot}`} />
                      )}
                      <span className="truncate">{crumb.name}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>

          {/* What this composition IS, in the two numbers that matter while
              editing one: how many lanes it stacks, and how long it runs. */}
          <div className="hidden flex-none items-center gap-2 pr-1 text-3xs text-zinc-500 sm:flex">
            <span className="flex items-center gap-1">
              <StackIcon className="h-3 w-3" aria-hidden />
              {t('comp.layers', { count: layers })}
            </span>
            <span className="tabular-nums">{formatTimeShort(durationMs)}</span>
          </div>
          {!coarse && !renaming && activeCompId && (
            <Tooltip label={t('comp.rename')}>
              <button
                className={`flex-none rounded p-1 hover:bg-zinc-800/70 ${colors.ink}`}
                onClick={() => useStore.getState().setRenamingComp(activeCompId)}
                aria-label={t('comp.rename')}
              >
                <Pencil1Icon className="h-3 w-3" />
              </button>
            </Tooltip>
          )}
        </m.nav>
      )}
    </AnimatePresence>
  );
}

/**
 * The current step, turned into a text field.
 *
 * Committed on Enter and on blur, abandoned on Escape - the same contract the
 * track and marker rename fields keep, so renaming anything in this editor
 * behaves the one way.
 */
function CompNameField({ compId, name }: { compId: string; name: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    useStore.getState().renameComp(compId, value);
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // The timeline's own hotkeys are listening on the window: a name with an
        // S or a K in it would split a clip and stop playback while being typed.
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
      placeholder={t('comp.namePlaceholder')}
      className="w-40 min-w-0 rounded border border-zinc-600 bg-zinc-950 px-1.5 py-0.5 text-2xs text-zinc-100 outline-none focus:border-blue-400"
    />
  );
}
