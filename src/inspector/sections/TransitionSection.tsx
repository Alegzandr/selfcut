import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Clip, TransitionType } from '../../types';
import { trackCrossfades } from '../../model';

/** Transition styles offered for an overlapping clip's entry. */
const TRANSITIONS: TransitionType[] = [
  'dissolve',
  'dipBlack',
  'dipWhite',
  'slideLeft',
  'slideRight',
  'slideUp',
  'slideDown',
  'wipe',
  'zoom',
];

/**
 * Transition picker for how the clip enters over its overlap with the previous
 * clip. Rendered only when such an overlap exists (Vegas-style: clips overlap to
 * transition); otherwise it explains how to make one, so picking a style is
 * never a no-op.
 */
export function TransitionSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const project = useStore((s) => s.project);
  const { updateClipCommitted } = useStore.getState();

  const track = project.tracks.find((tr) => tr.clips.some((c) => c.id === clip.id));
  const inMs = track ? trackCrossfades(track.clips).get(clip.id)?.inMs ?? 0 : 0;
  const current = clip.transition ?? 'dissolve';

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {t('inspector.transition')}
      </h3>
      {inMs > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {TRANSITIONS.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => updateClipCommitted(clip.id, { transition: type })}
              className={`touch-hit rounded px-2 py-1 text-[11px] font-medium ${
                current === type
                  ? 'bg-sky-500/20 text-sky-300'
                  : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'
              }`}
            >
              {t(`inspector.transition.${type}`)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-[11px] leading-snug text-zinc-500">{t('inspector.transition.hint')}</p>
      )}
    </div>
  );
}
