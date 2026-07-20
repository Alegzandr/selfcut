import { useTranslation } from 'react-i18next';
import { Crop, LayoutPanelTop, RotateCcw } from 'lucide-react';
import { useStore } from '../../store/store';
import { Tooltip } from '../../ui/Tooltip';
import { Clip, ClipTransform } from '../../types';
import { DEFAULT_TRANSFORM } from '../../model';
import { SliderRow } from '../SliderRow';
import { pct } from '../format';
import { CropSection } from './CropSection';

export function TransformSection({ clip, isVideo }: { clip: Clip; isVideo: boolean }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted, setCropEditing } = useStore.getState();
  const cropEditing = useStore((s) => s.cropEditing);
  const tf: ClipTransform = clip.transform ?? DEFAULT_TRANSFORM;
  const setTf = (patch: Partial<ClipTransform>) =>
    updateClip(clip.id, { transform: { ...tf, ...patch } });

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.transform')}
        </h3>
        <button
          className="touch-hit flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
          onClick={() => updateClipCommitted(clip.id, { transform: undefined })}
        >
          <RotateCcw className="h-3 w-3" />
          {t('inspector.reset')}
        </button>
      </div>
      {isVideo && (
        <div className="flex items-center gap-2">
          <Tooltip label={t('inspector.crop.hint')}>
            <button
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium ${cropEditing ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
              onClick={() => setCropEditing(!cropEditing)}
            >
              <Crop className="h-3.5 w-3.5" />
              {cropEditing ? t('inspector.crop.done') : t('inspector.crop.edit')}
            </button>
          </Tooltip>
          <Tooltip label={t('inspector.streamLayout.hint')}>
            <button
              className="touch-hit flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1.5 text-[11px] font-medium text-zinc-300 active:bg-zinc-700"
              onClick={() => useStore.getState().applyStreamLayout(clip.id)}
            >
              <LayoutPanelTop className="h-3.5 w-3.5" />
              {t('inspector.streamLayout')}
            </button>
          </Tooltip>
        </div>
      )}
      {/* 16:9 vers 9:16 en "cover" demande 3,16x : le max doit laisser de la marge au-dela. */}
      <SliderRow label={t('inspector.scale')} value={tf.scale} min={0.1} max={4} step={0.01} format={pct} onChange={(v) => setTf({ scale: v })} />
      <SliderRow label={t('inspector.positionX')} value={tf.x} min={0} max={1} step={0.01} format={pct} onChange={(v) => setTf({ x: v })} />
      <SliderRow label={t('inspector.positionY')} value={tf.y} min={0} max={1} step={0.01} format={pct} onChange={(v) => setTf({ y: v })} />
      {/* A full turn each way: tilting counter-clockwise is as common as clockwise. */}
      <SliderRow
        label={t('inspector.rotation')}
        value={tf.rotation ?? 0}
        min={-180}
        max={180}
        step={1}
        format={(v) => `${Math.round(v)}°`}
        onChange={(v) => setTf({ rotation: v })}
      />
      {isVideo && <CropSection clip={clip} />}
    </div>
  );
}
