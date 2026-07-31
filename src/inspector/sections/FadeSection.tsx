import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Clip } from '../../types';
import { SECONDS_ENTRY, SliderRow } from '../SliderRow';
import { seconds } from '../format';

export function FadeSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClip } = useStore.getState();
  return (
    <>
      <SliderRow
        label={t('inspector.fadeIn')}
        value={clip.fadeInMs}
        min={0}
        max={5000}
        step={100}
        format={seconds}
        entry={SECONDS_ENTRY}
        onChange={(v) => updateClip(clip.id, { fadeInMs: v })}
      />
      <SliderRow
        label={t('inspector.fadeOut')}
        value={clip.fadeOutMs}
        min={0}
        max={5000}
        step={100}
        format={seconds}
        entry={SECONDS_ENTRY}
        onChange={(v) => updateClip(clip.id, { fadeOutMs: v })}
      />
    </>
  );
}
