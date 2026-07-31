import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Clip, ClipTransform } from '../../types';
import { DEFAULT_TRANSFORM } from '../../model';
import { PERCENT_ENTRY, SliderRow } from '../SliderRow';
import { pct } from '../format';

export function CropSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClip } = useStore.getState();
  const tf: ClipTransform = clip.transform ?? DEFAULT_TRANSFORM;
  /**
   * The new rectangle comes from EACH edited clip's own crop and merges into
   * its own transform: with several clips selected, a fixed object would hand
   * them all this clip's position, scale and rotation along with it.
   */
  const setCrop = (patch: (crop: ClipTransform['crop']) => Partial<ClipTransform['crop']>) =>
    updateClip(clip.id, (c) => {
      const cur = c.transform ?? DEFAULT_TRANSFORM;
      return { transform: { ...cur, crop: { ...cur.crop, ...patch(cur.crop) } } };
    });

  return (
    <>
      <SliderRow label={t('inspector.cropLeft')} value={tf.crop.x} min={0} max={0.9} step={0.01} format={pct} entry={PERCENT_ENTRY} onChange={(v) => setCrop((cr) => ({ x: v, w: Math.min(cr.w, 1 - v) }))} />
      <SliderRow label={t('inspector.cropTop')} value={tf.crop.y} min={0} max={0.9} step={0.01} format={pct} entry={PERCENT_ENTRY} onChange={(v) => setCrop((cr) => ({ y: v, h: Math.min(cr.h, 1 - v) }))} />
      <SliderRow label={t('inspector.cropWidth')} value={tf.crop.w} min={0.05} max={1} step={0.01} format={pct} entry={PERCENT_ENTRY} onChange={(v) => setCrop((cr) => ({ w: Math.min(v, 1 - cr.x) }))} />
      <SliderRow label={t('inspector.cropHeight')} value={tf.crop.h} min={0.05} max={1} step={0.01} format={pct} entry={PERCENT_ENTRY} onChange={(v) => setCrop((cr) => ({ h: Math.min(v, 1 - cr.y) }))} />
    </>
  );
}
