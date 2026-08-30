import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Cross2Icon, Crosshair2Icon, ResetIcon } from '@radix-ui/react-icons';
import { useStore } from '../../store/store';
import { Clip, ClipMask, MaskMotion, MaskMotionProp } from '../../types';
import { sampleChannel } from '../../model';
import { trackMaskMotion } from '../../media/trackMotion';
import { PERCENT_ENTRY, SliderRow, type KeyframeControl, type NumericEntry } from '../SliderRow';

/**
 * The animated transform of a mask-shaped thing: four keyframable axes, plus the
 * motion tracker that fills them in from the footage.
 *
 * Shared by the clip mask and by every redaction region, because both are the
 * same shape on the output frame moved by the same `MaskMotion` — the caller
 * only says where the edits go. Keeping one copy is what makes "track it" behave
 * identically whether you are following a face with a spotlight or with a blur.
 */

/** Identity of each motion axis, its slider range, and the unit it is typed in. */
const MOTION_AXES: {
  prop: MaskMotionProp;
  labelKey: ParseKeys;
  def: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  entry?: NumericEntry;
}[] = [
  { prop: 'tx', labelKey: 'inspector.mask.offsetX', def: 0, min: -0.5, max: 0.5, step: 0.005, fmt: (v) => `${Math.round(v * 100)}%`, entry: PERCENT_ENTRY },
  { prop: 'ty', labelKey: 'inspector.mask.offsetY', def: 0, min: -0.5, max: 0.5, step: 0.005, fmt: (v) => `${Math.round(v * 100)}%`, entry: PERCENT_ENTRY },
  { prop: 'scale', labelKey: 'inspector.mask.scale', def: 1, min: 0.2, max: 3, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, entry: PERCENT_ENTRY },
  // Rotation is stored in the degrees it reads in, so it needs no mapping.
  { prop: 'rotation', labelKey: 'inspector.mask.rotation', def: 0, min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` },
];

export function MaskMotionControls({
  clip,
  shape,
  onLive,
  onToggleKey,
  onMotion,
}: {
  clip: Clip;
  /** The shape whose motion is edited: the clip's mask, or one redaction region. */
  shape: ClipMask;
  /** A slider drag: write `value` on `prop` (live, the gesture commits it). */
  onLive: (prop: MaskMotionProp, value: number) => void;
  /** The keyframe diamond of `prop`. */
  onToggleKey: (prop: MaskMotionProp) => void;
  /** A whole motion replaced at once: the tracker's result, or `undefined` to clear it. */
  onMotion: (motion: MaskMotion | undefined) => void;
}) {
  const { t } = useTranslation();
  // Subscribed so the motion sliders track the value under the playhead as it
  // moves — an animated axis reads its sampled value, not a stale constant.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const local = currentTimeMs - clip.timelineStartMs;
  const asset = useStore((s) => s.assets[clip.assetId]);
  const trackable = asset?.kind === 'video';
  const hasMotion = !!shape.motion;
  const [tracking, setTracking] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const motionValue = (prop: MaskMotionProp, def: number): number => {
    const ch = shape.motion?.[prop];
    return ch === undefined ? def : sampleChannel(ch, local);
  };

  const motionKf = (prop: MaskMotionProp, label: string): KeyframeControl => {
    const ch = shape.motion?.[prop];
    const keys = Array.isArray(ch) ? ch : undefined;
    return {
      animated: !!keys,
      onKey: (keys ?? []).some((k) => Math.abs(k.t - local) < 1),
      onToggle: () => onToggleKey(prop),
      label: `${t('inspector.keyframe')} · ${label}`,
    };
  };

  const runTracking = async () => {
    if (!asset || asset.kind !== 'video') return;
    const st = useStore.getState();
    const ac = new AbortController();
    abortRef.current = ac;
    setTracking(0);
    try {
      const motion = await trackMaskMotion(
        clip,
        asset,
        shape,
        { fromMs: st.currentTimeMs, fps: Math.min(30, asset.fps ?? 30) },
        (frac) => setTracking(frac),
        ac.signal,
      );
      if (motion && !ac.signal.aborted) {
        st.beginGesture();
        onMotion(motion);
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
    const st = useStore.getState();
    st.beginGesture();
    onMotion(undefined);
    st.endGesture();
  };

  return (
    // Animated motion: keyframe these to move the shape over time, or let motion
    // tracking fill them in. The diamonds work exactly like the colour/transform
    // keyframes.
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
            entry={axis.entry}
            defaultValue={axis.def}
            onChange={(v) => onLive(axis.prop, v)}
            keyframe={motionKf(axis.prop, label)}
          />
        );
      })}

      {/* Motion tracking: analyse the footage under the shape from the playhead
          forward and write the motion keyframes above. */}
      {trackable &&
        (tracking !== null ? (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-blue-500 transition-[width]"
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
              <Cross2Icon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void runTracking()}
              className="touch-hit flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1.5 text-2xs font-medium text-zinc-200 hover:bg-zinc-700/70 active:bg-zinc-700"
            >
              <Crosshair2Icon className="h-3.5 w-3.5" />
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
                <ResetIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
    </div>
  );
}
