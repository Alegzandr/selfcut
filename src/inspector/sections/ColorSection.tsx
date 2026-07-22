import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useStore } from '../../store/store';
import { Channel, ClipColor, Clip } from '../../types';
import { sampleChannel } from '../../model';
import { SliderRow } from '../SliderRow';

/** The colour params, in inspector order, with their slider ranges. */
const PARAMS: { key: keyof ClipColor; min: number; max: number }[] = [
  { key: 'brightness', min: -1, max: 1 },
  { key: 'contrast', min: -1, max: 1 },
  { key: 'saturation', min: -1, max: 1 },
  { key: 'temperature', min: -1, max: 1 },
  { key: 'tint', min: -1, max: 1 },
  { key: 'vignette', min: 0, max: 1 },
];

/** Current value of a colour channel as a plain number (constant until keyframed). */
function value(ch: Channel | undefined): number {
  return ch === undefined ? 0 : sampleChannel(ch, 0);
}

/**
 * Colour grading ("Adjust"): brightness, contrast, saturation, white balance and
 * vignette, run through the WebGL colour pass. Shown for video and image clips.
 */
export function ColorSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted } = useStore.getState();
  const color = clip.color;

  const setParam = (key: keyof ClipColor, v: number) =>
    updateClip(clip.id, { color: { ...color, [key]: v } });

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.adjust')}
        </h3>
        <button
          className="touch-hit flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
          onClick={() => updateClipCommitted(clip.id, { color: undefined })}
        >
          <RotateCcw className="h-3 w-3" />
          {t('inspector.reset')}
        </button>
      </div>
      {PARAMS.map(({ key, min, max }) => (
        <SliderRow
          key={key}
          label={t(`inspector.adjust.${key}`)}
          value={value(color?.[key])}
          min={min}
          max={max}
          step={0.01}
          format={(v) => (min < 0 ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}` : `${Math.round(v * 100)}%`)}
          onChange={(v) => setParam(key, v)}
        />
      ))}
    </div>
  );
}
