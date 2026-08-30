import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { ToggleButton } from '../../ui/ToggleButton';
import { Clip } from '../../types';
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from '../../app/config';

export function SpeedControl({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClipCommitted } = useStore.getState();
  // A rate stretch on the timeline lands on no round number, and the field is
  // an editable value, not a read-out: show it at the precision someone would
  // type back, not the drag's full float.
  const shown = (v: number) => String(Math.round(v * 100) / 100);
  const [text, setText] = useState(shown(clip.speed));
  useEffect(() => setText(shown(clip.speed)), [clip.id, clip.speed]);

  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (isFinite(v) && v >= MIN_CLIP_SPEED && v <= MAX_CLIP_SPEED) {
      updateClipCommitted(clip.id, { speed: v });
    }
    else setText(shown(clip.speed));
  };

  return (
    <div className="flex items-start gap-2 text-xs text-zinc-400">
      <span className="w-16 flex-none pt-1.5">{t('inspector.speed')}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {[0.5, 1, 1.5, 2].map((s) => (
          <ToggleButton
            key={s}
            active={clip.speed === s}
            onClick={() => updateClipCommitted(clip.id, { speed: s })}
          >
            {s}×
          </ToggleButton>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            min={MIN_CLIP_SPEED}
            max={MAX_CLIP_SPEED}
            step={0.1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="w-14 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-zinc-200 outline-none focus:border-brand-500"
          />
          <span>×</span>
        </div>
      </div>
    </div>
  );
}
