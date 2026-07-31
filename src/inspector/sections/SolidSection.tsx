import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Tooltip } from '../../ui/Tooltip';
import { ToggleButton } from '../../ui/ToggleButton';
import { Clip, ClipSolid, SolidClip } from '../../types';

export function SolidSection({ clip }: { clip: SolidClip }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted, beginGesture, endGesture } = useStore.getState();
  const solid = clip.solid;
  /** Merged per clip, so a multi-selection keeps each fill's own other fields. */
  const solidPatch = (patch: Partial<ClipSolid>) => (c: Clip) =>
    c.kind === 'solid' ? { solid: { ...c.solid, ...patch } } : {};
  const setSolid = (patch: Partial<ClipSolid>) => updateClip(clip.id, solidPatch(patch));
  const commitSolid = (patch: Partial<ClipSolid>) =>
    updateClipCommitted(clip.id, solidPatch(patch));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.fill')}</span>
        {(['color', 'gradient'] as const).map((kind) => (
          <ToggleButton key={kind} active={solid.kind === kind} onClick={() => commitSolid({ kind })}>
            {t(`inspector.solid.${kind}`)}
          </ToggleButton>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.colors')}</span>
        <Tooltip label={t('inspector.solid.firstColor')}>
          <input type="color" value={solid.color} className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800" onFocus={beginGesture} onBlur={endGesture} onChange={(e) => setSolid({ color: e.target.value })} />
        </Tooltip>
        {solid.kind === 'gradient' && (
          <Tooltip label={t('inspector.solid.secondColor')}>
            <input type="color" value={solid.color2 ?? solid.color} className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800" onFocus={beginGesture} onBlur={endGesture} onChange={(e) => setSolid({ color2: e.target.value })} />
          </Tooltip>
        )}
      </div>
      {solid.kind === 'gradient' && (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="w-16 flex-none">{t('inspector.direction')}</span>
          {[0, 45, 90, 135].map((angle) => <ToggleButton key={angle} active={solid.angle === angle} onClick={() => commitSolid({ angle })}>{angle}°</ToggleButton>)}
        </div>
      )}
    </div>
  );
}
