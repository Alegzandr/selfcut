import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Clip, ClipMask } from '../../types';
import { PERCENT_ENTRY, SliderRow } from '../SliderRow';
import { MaskMotionControls } from './MaskMotionControls';

/**
 * Shape mask: switch it on, choose a rectangle or ellipse, place and size it,
 * and soften the edge. Only the pixels inside the shape are kept (or outside,
 * when inverted), so lower tracks show through the rest — the split-screen and
 * spotlight tool. The mask is a fixed window on the OUTPUT frame, so it holds
 * still while the clip inside it moves.
 *
 * To hide something rather than reveal it, see the redaction regions below it:
 * a mask cuts the clip away, which is the wrong tool for a face in the middle
 * of a shot you still want to see.
 */

const DEFAULT_MASK: ClipMask = {
  shape: 'ellipse',
  x: 0.5,
  y: 0.5,
  w: 0.6,
  h: 0.6,
  feather: 0.03,
  invert: false,
};

export function MaskSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const mask = clip.mask;
  const enabled = !!mask;
  // Subscribed so a motion edit lands on the keyframe under the playhead.
  const currentTimeMs = useStore((s) => s.currentTimeMs);

  const toggle = () => {
    const st = useStore.getState();
    st.beginGesture();
    st.setClipMask(clip.id, enabled ? undefined : DEFAULT_MASK);
    st.endGesture();
  };

  const set = (patch: Partial<ClipMask>) => {
    useStore.getState().setClipMask(clip.id, { ...(mask ?? DEFAULT_MASK), ...patch });
  };

  const commit = (patch: Partial<ClipMask>) => {
    const st = useStore.getState();
    st.beginGesture();
    set(patch);
    st.endGesture();
  };

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <label className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.mask')}
        </h3>
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="h-3.5 w-3.5 accent-brand-500"
          aria-label={t('inspector.mask')}
        />
      </label>

      {enabled && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-16 flex-none text-xs text-zinc-500">{t('inspector.mask.shape')}</span>
            <div className="flex flex-1 gap-1">
              {(['rect', 'ellipse'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={mask!.shape === s}
                  onClick={() => commit({ shape: s })}
                  className={`touch-hit flex-1 rounded px-2 py-1 text-2xs ${
                    mask!.shape === s
                      ? 'bg-brand-500/20 text-brand-300'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                  }`}
                >
                  {t(`inspector.mask.${s}`)}
                </button>
              ))}
              {/* Pen: activates the preview draw tool. Highlighted once the mask
                  is a drawn path. */}
              <button
                type="button"
                aria-pressed={mask!.shape === 'path'}
                onClick={() => useStore.getState().setPreviewTool('pen')}
                className={`touch-hit flex-1 rounded px-2 py-1 text-2xs ${
                  mask!.shape === 'path'
                    ? 'bg-brand-500/20 text-brand-300'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                }`}
              >
                {t('inspector.mask.pen')}
              </button>
            </div>
          </div>
          {mask!.shape === 'path' && (
            <p className="text-2xs text-zinc-600">{t('inspector.mask.pen.hint')}</p>
          )}
          {mask!.shape !== 'path' && (
            <>
              <SliderRow
                label={t('inspector.mask.x')}
                value={mask!.x}
                min={0}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                entry={PERCENT_ENTRY}
                onChange={(v) => set({ x: v })}
              />
              <SliderRow
                label={t('inspector.mask.y')}
                value={mask!.y}
                min={0}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                entry={PERCENT_ENTRY}
                onChange={(v) => set({ y: v })}
              />
              <SliderRow
                label={t('inspector.mask.width')}
                value={mask!.w}
                min={0.02}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                entry={PERCENT_ENTRY}
                onChange={(v) => set({ w: v })}
              />
              <SliderRow
                label={t('inspector.mask.height')}
                value={mask!.h}
                min={0.02}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                entry={PERCENT_ENTRY}
                onChange={(v) => set({ h: v })}
              />
            </>
          )}
          <SliderRow
            label={t('inspector.mask.feather')}
            value={mask!.feather}
            min={0}
            max={0.3}
            step={0.005}
            format={(v) => `${Math.round(v * 100)}%`}
            entry={PERCENT_ENTRY}
            onChange={(v) => set({ feather: v })}
          />
          <label className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t('inspector.mask.invert')}</span>
            <input
              type="checkbox"
              checked={!!mask!.invert}
              onChange={(e) => commit({ invert: e.target.checked })}
              className="h-3.5 w-3.5 accent-brand-500"
            />
          </label>

          <MaskMotionControls
            clip={clip}
            shape={mask!}
            onLive={(prop, v) =>
              useStore.getState().setClipMaskMotionLive(clip.id, prop, v, currentTimeMs)
            }
            onToggleKey={(prop) =>
              useStore.getState().toggleClipMaskMotionKeyframe(clip.id, prop, currentTimeMs)
            }
            onMotion={(motion) => useStore.getState().setClipMask(clip.id, { ...mask!, motion })}
          />
        </>
      )}
    </div>
  );
}
