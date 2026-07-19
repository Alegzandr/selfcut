import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { ToggleButton } from '../../ui/ToggleButton';
import { Clip } from '../../types';
import { SliderRow } from '../SliderRow';
import { gainDb } from '../format';
import { faderToGain, gainToFader } from '../../lib/gain';

export function AudioSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted } = useStore.getState();

  // Pan read-out: the letter is the localised initial of Center/Left/Right.
  const pan = (v: number) => {
    if (v === 0) return t('inspector.pan.center');
    const side = v < 0 ? t('inspector.pan.left') : t('inspector.pan.right');
    return `${side}${Math.round(Math.abs(v) * 100)}`;
  };

  return (
    <>
      {/* Volume rides a dB fader scale, not the raw linear gain: min/max/step
          here are fader positions, converted on both sides. */}
      <SliderRow
        label={t('inspector.volume')}
        value={gainToFader(clip.volume)}
        min={0}
        max={1}
        step={0.001}
        format={(p) => gainDb(faderToGain(p))}
        onChange={(p) => updateClip(clip.id, { volume: faderToGain(p) })}
      />
      <SliderRow
        label={t('inspector.balance')}
        value={clip.pan ?? 0}
        min={-1}
        max={1}
        step={0.01}
        format={pan}
        onChange={(v) => updateClip(clip.id, { pan: v })}
      />
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.channels')}</span>
        <ToggleButton
          active={!clip.mono}
          onClick={() => updateClipCommitted(clip.id, { mono: false })}
        >
          {t('inspector.stereo')}
        </ToggleButton>
        <ToggleButton
          active={!!clip.mono}
          onClick={() => updateClipCommitted(clip.id, { mono: true })}
        >
          {t('inspector.mono')}
        </ToggleButton>
      </div>
    </>
  );
}
