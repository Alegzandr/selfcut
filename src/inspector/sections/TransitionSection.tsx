import { useTranslation } from 'react-i18next';
import { useStore, getLanes } from '../../store/store';
import { Clip } from '../../types';
import { trackCrossfades } from '../../model';
import { seconds } from '../format';

/**
 * What transition this clip enters on, if any. A read-out, not a picker: the
 * nine styles are the library's Transitions tab now, and listing them again
 * here would be the same catalogue twice.
 *
 * Transitions are derived purely from clip overlap (Vegas-style), so there is
 * nothing to "delete" from this panel either - dragging the clips apart on the
 * timeline is what removes the crossfade.
 */
export function TransitionSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const lanes = useStore(getLanes);

  const track = lanes.find((tr) => tr.clips.some((c) => c.id === clip.id));
  const inMs = track ? trackCrossfades(track.clips).get(clip.id)?.inMs ?? 0 : 0;

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {t('inspector.transition')}
      </h3>
      {inMs > 0 ? (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-zinc-200">
            {t(`inspector.transition.${clip.transition ?? 'dissolve'}`)}
          </span>
          <span className="flex-none tabular-nums text-zinc-400">{seconds(inMs)}</span>
        </div>
      ) : (
        <p className="text-2xs leading-snug text-zinc-500">{t('inspector.transition.hint')}</p>
      )}
    </div>
  );
}
