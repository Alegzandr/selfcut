import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { ToggleButton } from '../../ui/ToggleButton';
import { Clip } from '../../types';

export function SpeedControl({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClipCommitted } = useStore.getState();
  const [text, setText] = useState(String(clip.speed));
  useEffect(() => setText(String(clip.speed)), [clip.id, clip.speed]);

  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (isFinite(v) && v >= 0.1 && v <= 8) updateClipCommitted(clip.id, { speed: v });
    else setText(String(clip.speed));
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
            min={0.1}
            max={8}
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
