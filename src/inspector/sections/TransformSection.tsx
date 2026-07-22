import { useTranslation } from 'react-i18next';
import { Crop, LayoutPanelTop, RotateCcw } from 'lucide-react';
import { useStore } from '../../store/store';
import { Tooltip } from '../../ui/Tooltip';
import { AnimatableProp, Clip } from '../../types';
import { resolveTransform } from '../../model';
import { SliderRow, type KeyframeControl } from '../SliderRow';
import { pct } from '../format';
import { CropSection } from './CropSection';

/** Two keyframe times within this many ms count as sitting on the same playhead. */
const ON_KEY_EPSILON_MS = 1;

export function TransformSection({ clip, isVideo }: { clip: Clip; isVideo: boolean }) {
  const { t } = useTranslation();
  const { updateClipTransformLive, toggleClipKeyframe, updateClipCommitted, setCropEditing } =
    useStore.getState();
  const cropEditing = useStore((s) => s.cropEditing);
  // Subscribed so the sliders and diamonds track the value at the playhead as it
  // moves — an animated property reads its sampled value, not a stale static one.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const rt = resolveTransform(clip, currentTimeMs);
  const local = currentTimeMs - clip.timelineStartMs;

  const setProp = (prop: 'x' | 'y' | 'scale' | 'rotation', v: number) =>
    updateClipTransformLive(clip.id, { [prop]: v }, currentTimeMs);

  const kf = (prop: AnimatableProp, propLabel: string): KeyframeControl => {
    const keys = clip.animation?.[prop];
    return {
      animated: !!keys?.length,
      onKey: (keys ?? []).some((k) => Math.abs(k.t - local) < ON_KEY_EPSILON_MS),
      onToggle: () => toggleClipKeyframe(clip.id, prop, currentTimeMs),
      label: `${t('inspector.keyframe')} · ${propLabel}`,
    };
  };

  const scaleLabel = t('inspector.scale');
  const xLabel = t('inspector.positionX');
  const yLabel = t('inspector.positionY');
  const rotationLabel = t('inspector.rotation');

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.transform')}
        </h3>
        <button
          className="touch-hit flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
          onClick={() => updateClipCommitted(clip.id, { transform: undefined, animation: undefined })}
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
      <SliderRow label={scaleLabel} value={rt.scale} min={0.1} max={4} step={0.01} format={pct} onChange={(v) => setProp('scale', v)} keyframe={kf('scale', scaleLabel)} />
      <SliderRow label={xLabel} value={rt.x} min={0} max={1} step={0.01} format={pct} onChange={(v) => setProp('x', v)} keyframe={kf('x', xLabel)} />
      <SliderRow label={yLabel} value={rt.y} min={0} max={1} step={0.01} format={pct} onChange={(v) => setProp('y', v)} keyframe={kf('y', yLabel)} />
      {/* A full turn each way: tilting counter-clockwise is as common as clockwise. */}
      <SliderRow
        label={rotationLabel}
        value={rt.rotation}
        min={-180}
        max={180}
        step={1}
        format={(v) => `${Math.round(v)}°`}
        onChange={(v) => setProp('rotation', v)}
        keyframe={kf('rotation', rotationLabel)}
      />
      {isVideo && <CropSection clip={clip} />}
    </div>
  );
}
