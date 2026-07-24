import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Crosshair, RotateCcw, X } from 'lucide-react';
import { useStore } from '../../store/store';
import { Clip, ClipMask, MaskMotionProp } from '../../types';
import { sampleChannel } from '../../model';
import { trackMaskMotion } from '../../media/trackMotion';
import { SliderRow, type KeyframeControl } from '../SliderRow';

/**
 * Shape mask: switch it on, choose a rectangle or ellipse, place and size it,
 * and soften the edge. Only the pixels inside the shape are kept (or outside,
 * when inverted), so lower tracks show through the rest — the split-screen and
 * spotlight tool. The mask is a fixed window on the OUTPUT frame, so it holds
 * still while the clip inside it moves.
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

/** Identity of each motion axis, and its slider range. */
const MOTION_AXES: { prop: MaskMotionProp; labelKey: ParseKeys; def: number; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { prop: 'tx', labelKey: 'inspector.mask.offsetX', def: 0, min: -0.5, max: 0.5, step: 0.005, fmt: (v) => `${Math.round(v * 100)}%` },
  { prop: 'ty', labelKey: 'inspector.mask.offsetY', def: 0, min: -0.5, max: 0.5, step: 0.005, fmt: (v) => `${Math.round(v * 100)}%` },
  { prop: 'scale', labelKey: 'inspector.mask.scale', def: 1, min: 0.2, max: 3, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { prop: 'rotation', labelKey: 'inspector.mask.rotation', def: 0, min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` },
];

export function MaskSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const mask = clip.mask;
  const enabled = !!mask;
  // Subscribed so the motion sliders track the value under the playhead as it
  // moves — an animated axis reads its sampled value, not a stale constant.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const local = currentTimeMs - clip.timelineStartMs;

  const motionValue = (prop: MaskMotionProp, def: number): number => {
    const ch = mask?.motion?.[prop];
    return ch === undefined ? def : sampleChannel(ch, local);
  };

  const asset = useStore((s) => s.assets[clip.assetId]);
  const trackable = asset?.kind === 'video';
  const hasMotion = !!mask?.motion;
  const [tracking, setTracking] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runTracking = async () => {
    if (!mask || !asset || asset.kind !== 'video') return;
    const st = useStore.getState();
    const ac = new AbortController();
    abortRef.current = ac;
    setTracking(0);
    try {
      const motion = await trackMaskMotion(
        clip,
        asset,
        mask,
        { fromMs: st.currentTimeMs, fps: Math.min(30, asset.fps ?? 30) },
        (frac) => setTracking(frac),
        ac.signal,
      );
      if (motion && !ac.signal.aborted) {
        st.beginGesture();
        st.setClipMask(clip.id, { ...mask, motion });
        st.endGesture();
      }
    } catch (err) {
      console.warn('[track] motion tracking failed:', err);
    } finally {
      setTracking(null);
      abortRef.current = null;
    }
  };

  const clearMotion = () => {
    if (!mask) return;
    const st = useStore.getState();
    st.beginGesture();
    st.setClipMask(clip.id, { ...mask, motion: undefined });
    st.endGesture();
  };

  const motionKf = (prop: MaskMotionProp, label: string): KeyframeControl => {
    const ch = mask?.motion?.[prop];
    const keys = Array.isArray(ch) ? ch : undefined;
    return {
      animated: !!keys,
      onKey: (keys ?? []).some((k) => Math.abs(k.t - local) < 1),
      onToggle: () => useStore.getState().toggleClipMaskMotionKeyframe(clip.id, prop, currentTimeMs),
      label: `${t('inspector.keyframe')} · ${label}`,
    };
  };

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
          className="h-3.5 w-3.5 accent-sky-500"
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
                      ? 'bg-sky-500/20 text-sky-300'
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
                    ? 'bg-sky-500/20 text-sky-300'
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
                onChange={(v) => set({ x: v })}
              />
              <SliderRow
                label={t('inspector.mask.y')}
                value={mask!.y}
                min={0}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set({ y: v })}
              />
              <SliderRow
                label={t('inspector.mask.width')}
                value={mask!.w}
                min={0.02}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set({ w: v })}
              />
              <SliderRow
                label={t('inspector.mask.height')}
                value={mask!.h}
                min={0.02}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
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
            onChange={(v) => set({ feather: v })}
          />
          <label className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t('inspector.mask.invert')}</span>
            <input
              type="checkbox"
              checked={!!mask!.invert}
              onChange={(e) => commit({ invert: e.target.checked })}
              className="h-3.5 w-3.5 accent-sky-500"
            />
          </label>

          {/* Animated motion: keyframe these to move the mask over time, or let
              motion tracking fill them in. The diamonds work exactly like the
              colour/transform keyframes. */}
          <div className="space-y-2 border-t border-zinc-800/70 pt-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-zinc-600">
              {t('inspector.mask.motion')}
            </h4>
            {MOTION_AXES.map((axis) => {
              const label = t(axis.labelKey);
              return (
                <SliderRow
                  key={axis.prop}
                  label={label}
                  value={motionValue(axis.prop, axis.def)}
                  min={axis.min}
                  max={axis.max}
                  step={axis.step}
                  format={axis.fmt}
                  onChange={(v) =>
                    useStore.getState().setClipMaskMotionLive(clip.id, axis.prop, v, currentTimeMs)
                  }
                  keyframe={motionKf(axis.prop, label)}
                />
              );
            })}

            {/* Motion tracking: analyse the footage under the mask from the
                playhead forward and write the motion keyframes above. */}
            {trackable &&
              (tracking !== null ? (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-sky-500 transition-[width]"
                      style={{ width: `${Math.round(tracking * 100)}%` }}
                    />
                  </div>
                  <span className="text-2xs tabular-nums text-zinc-400">
                    {t('inspector.mask.tracking', { pct: Math.round(tracking * 100) })}
                  </span>
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="touch-hit rounded p-0.5 text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
                    aria-label={t('confirm.cancel')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void runTracking()}
                    className="touch-hit flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1.5 text-2xs font-medium text-zinc-200 hover:bg-zinc-700/70 active:bg-zinc-700"
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                    {t('inspector.mask.track')}
                  </button>
                  {hasMotion && (
                    <button
                      type="button"
                      onClick={clearMotion}
                      title={t('inspector.mask.clearMotion')}
                      aria-label={t('inspector.mask.clearMotion')}
                      className="touch-hit rounded-md border border-zinc-700 px-2 py-1.5 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
