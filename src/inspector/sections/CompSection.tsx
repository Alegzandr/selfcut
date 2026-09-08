import { useTranslation } from 'react-i18next';
import { EnterIcon, ExitIcon, Pencil1Icon, StackIcon } from '@radix-ui/react-icons';
import type { CompClip } from '../../types';
import { findComp, playsWholeComp, tracksDurationMs } from '../../model';
import { useStore } from '../../store/store';
import { formatTimeShort } from '../../lib/time';
import { compColorClass } from '../../timeline/compColors';
import { Tooltip } from '../../ui/Tooltip';
import { decomposeWithConfirm } from '../../ui/compActions';

/**
 * What a comp clip is, and the two things only it can do: step inside, and give
 * back the length of what it plays.
 *
 * It sits at the TOP of the inspector, above speed and fades, because those act
 * on the composition as a layer while this is about the composition itself -
 * and because "open it" is what someone who selected a precomp most often meant
 * to do next.
 */
export function CompSection({ clip }: { clip: CompClip }) {
  const { t } = useTranslation();
  const comp = useStore((s) => findComp(s.project, clip.compId) ?? null);
  if (!comp) return null;

  const colors = compColorClass(comp.color);
  const fullMs = tracksDurationMs(comp.tracks);
  // A clip already playing the composition whole has nothing to fit to, and a
  // button that would do nothing is a button that reads as broken.
  const fitted = playsWholeComp(clip, fullMs);

  return (
    <div className={`space-y-2 rounded-lg border border-zinc-800 p-2 ${colors.body}`}>
      <div className="flex items-center gap-2">
        <StackIcon className={`h-4 w-4 flex-none ${colors.ink}`} />
        <span className={`min-w-0 flex-1 truncate text-xs font-semibold ${colors.ink}`}>
          {comp.name}
        </span>
        <Tooltip label={t('comp.rename')}>
          <button
            className={`touch-hit flex-none rounded p-1 hover:bg-black/30 pointer-coarse:p-2 ${colors.ink}`}
            onClick={() => {
              // Renamed where it is visible: the library card and the trail are
              // the two places the name is read, and the trail is where the user
              // lands the moment they open it.
              useStore.getState().setRenamingComp(comp.id);
              useStore.getState().setLibraryOpen(true);
            }}
            aria-label={t('comp.rename')}
          >
            <Pencil1Icon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex items-center gap-2 text-3xs text-white/55">
        <span>{t('comp.layers', { count: comp.tracks.length })}</span>
        <span className="tabular-nums">{formatTimeShort(fullMs)}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          className="touch-hit flex items-center gap-1.5 rounded border border-white/20 bg-black/25 px-2 py-1 text-2xs font-medium text-white hover:bg-black/40 pointer-coarse:py-2"
          onClick={() => useStore.getState().openComp(comp.id)}
        >
          <EnterIcon className="h-3.5 w-3.5" />
          {t('comp.open')}
        </button>
        <button
          className="touch-hit flex items-center gap-1.5 rounded border border-white/20 bg-black/25 px-2 py-1 text-2xs font-medium text-white hover:bg-black/40 disabled:opacity-40 pointer-coarse:py-2"
          disabled={fitted || fullMs <= 0}
          // Back to the whole composition, from wherever the trim was left. The
          // one edit that needs to know the composition's length, which is why
          // it cannot live on the generic trim controls.
          onClick={() =>
            useStore.getState().updateClipCommitted(clip.id, { sourceInMs: 0, sourceOutMs: fullMs })
          }
        >
          {t('comp.fit')}
        </button>
        <button
          className="touch-hit flex items-center gap-1.5 rounded border border-white/20 bg-black/25 px-2 py-1 text-2xs font-medium text-white hover:bg-black/40 pointer-coarse:py-2"
          onClick={() => void decomposeWithConfirm(clip.id)}
        >
          <ExitIcon className="h-3.5 w-3.5" />
          {t('comp.decompose')}
        </button>
      </div>
    </div>
  );
}
