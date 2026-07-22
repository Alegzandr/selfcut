import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useStore } from '../../store/store';
import { Channel, Clip, ColorProp, EaseId } from '../../types';
import { COLOR_PROPS, EASE_IDS, keyframesOf, sampleChannel } from '../../model';
import { SliderRow, type KeyframeControl } from '../SliderRow';

/** Two keyframe times within this many ms count as sitting on the same playhead. */
const ON_KEY_EPSILON_MS = 1;

/** Slider range of each colour param, in the order `COLOR_PROPS` lists them. */
const RANGES: Record<ColorProp, { min: number; max: number }> = {
  brightness: { min: -1, max: 1 },
  contrast: { min: -1, max: 1 },
  saturation: { min: -1, max: 1 },
  temperature: { min: -1, max: 1 },
  tint: { min: -1, max: 1 },
  vignette: { min: 0, max: 1 },
  blur: { min: 0, max: 1 },
};

/** Value of a colour channel at a clip-local time. Absent means identity (0). */
function valueAt(ch: Channel | undefined, localMs: number): number {
  return ch === undefined ? 0 : sampleChannel(ch, localMs);
}

/**
 * Colour grading ("Adjust"): brightness, contrast, saturation, white balance and
 * vignette, run through the WebGL colour pass. Shown for video and image clips.
 *
 * Parameters only. The one-tap looks (B&W, Warm, Vintage…) that used to head
 * this section are the library's Effects tab now: the catalogue is where you
 * pick a grade, the inspector is where you tune the one you picked.
 *
 * Every parameter is keyframable, exactly like the transform props - the same
 * diamond, the same easing picker. A grade that can only be constant is a grade
 * that cannot follow a shot as its light changes.
 */
export function ColorSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClipColorLive, toggleClipKeyframe, setClipKeyframesEase, setSelectedKeyframesEase, updateClipCommitted } =
    useStore.getState();
  const selectedKeyframes = useStore((s) => s.selectedKeyframes);
  // Subscribed so the sliders track the value at the playhead as it moves: an
  // animated parameter reads its sampled value, not a stale constant.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const local = currentTimeMs - clip.timelineStartMs;
  const color = clip.color;

  const kf = (prop: ColorProp, propLabel: string): KeyframeControl => {
    const keys = keyframesOf(clip, prop);
    return {
      animated: !!keys,
      onKey: (keys ?? []).some((k) => Math.abs(k.t - local) < ON_KEY_EPSILON_MS),
      onToggle: () => toggleClipKeyframe(clip.id, prop, currentTimeMs),
      label: `${t('inspector.keyframe')} · ${propLabel}`,
    };
  };

  // Easing of the colour keyframe under the playhead, if any: all params at a
  // given time share one picker, so read the first that has a key there.
  let easeAtPlayhead: EaseId | null = null;
  for (const prop of COLOR_PROPS) {
    const k = keyframesOf(clip, prop)?.find((kk) => Math.abs(kk.t - local) < ON_KEY_EPSILON_MS);
    if (k) {
      easeAtPlayhead = k.ease ?? 'inOut';
      break;
    }
  }
  const boxed = selectedKeyframes.length;

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.adjust')}
        </h3>
        <button
          className="touch-hit flex items-center gap-1 rounded-md px-2 py-1 text-2xs text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
          onClick={() => updateClipCommitted(clip.id, { color: undefined })}
        >
          <RotateCcw className="h-3 w-3" />
          {t('inspector.reset')}
        </button>
      </div>
      {COLOR_PROPS.map((key) => {
        const { min, max } = RANGES[key];
        const label = t(`inspector.adjust.${key}`);
        return (
          <SliderRow
            key={key}
            label={label}
            value={valueAt(color?.[key], local)}
            min={min}
            max={max}
            step={0.01}
            format={(v) =>
              min < 0 ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}` : `${Math.round(v * 100)}%`
            }
            onChange={(v) => updateClipColorLive(clip.id, key, v, currentTimeMs)}
            keyframe={kf(key, label)}
          />
        );
      })}
      {/* Only shown when there is a key to re-ease: a picker that acts on nothing
          is worse than no picker. */}
      {easeAtPlayhead !== null && (
        <div className="flex items-center gap-2 pt-0.5">
          <span className="w-16 flex-none text-xs text-zinc-500">{t('inspector.easing')}</span>
          <div className="flex flex-1 flex-wrap gap-1">
            {EASE_IDS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => (boxed ? setSelectedKeyframesEase(e) : setClipKeyframesEase(clip.id, local, e))}
                className={`touch-hit rounded px-1.5 py-1 text-2xs ${
                  easeAtPlayhead === e
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                }`}
              >
                {t(`inspector.easing.${e}`)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
