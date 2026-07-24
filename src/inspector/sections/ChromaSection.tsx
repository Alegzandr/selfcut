import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Clip, ClipColor } from '../../types';
import { SliderRow } from '../SliderRow';

/**
 * Chroma key (green screen): switch it on, pick the colour to remove, and dial
 * the matte. `similarity` widens the keyed hue range, `smoothness` softens the
 * edge, `spill` pulls the green fringe off the subject. The keying runs in the
 * same WebGL colour pass as the sliders, so preview and export match, and lower
 * tracks show through wherever the key cuts.
 */

const DEFAULT_KEY: NonNullable<ClipColor['chromaKey']> = {
  color: '#00ff00',
  similarity: 0.4,
  smoothness: 0.1,
  spill: 0.5,
};

export function ChromaSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const key = clip.color?.chromaKey;
  const enabled = !!key;

  const toggle = () => {
    const st = useStore.getState();
    st.beginGesture();
    st.setClipChromaKey(clip.id, enabled ? undefined : DEFAULT_KEY);
    st.endGesture();
  };

  // Slider live-set: the SliderRow's own pointer gesture opens/closes the undo
  // step, so this just writes the merged key.
  const set = (patch: Partial<NonNullable<ClipColor['chromaKey']>>) => {
    useStore.getState().setClipChromaKey(clip.id, { ...(key ?? DEFAULT_KEY), ...patch });
  };

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <label className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.chroma')}
        </h3>
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="h-3.5 w-3.5 accent-sky-500"
          aria-label={t('inspector.chroma')}
        />
      </label>

      {enabled && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-16 flex-none text-xs text-zinc-500">{t('inspector.chroma.color')}</span>
            <input
              type="color"
              value={key!.color}
              onChange={(e) => {
                const st = useStore.getState();
                st.beginGesture();
                set({ color: e.target.value });
                st.endGesture();
              }}
              className="h-7 w-10 flex-none cursor-pointer rounded border border-zinc-700 bg-zinc-800"
              aria-label={t('inspector.chroma.color')}
            />
            <span className="flex-1 font-mono text-2xs uppercase text-zinc-400">{key!.color}</span>
          </div>
          <SliderRow
            label={t('inspector.chroma.similarity')}
            value={key!.similarity}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ similarity: v })}
          />
          <SliderRow
            label={t('inspector.chroma.smoothness')}
            value={key!.smoothness}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ smoothness: v })}
          />
          <SliderRow
            label={t('inspector.chroma.spill')}
            value={key!.spill}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ spill: v })}
          />
        </>
      )}
    </div>
  );
}
