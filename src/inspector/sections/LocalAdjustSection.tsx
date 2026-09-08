import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { EyeClosedIcon, EyeOpenIcon, PlusIcon, TrashIcon } from '@radix-ui/react-icons';
import { useStore } from '../../store/store';
import { Clip, ClipLocalAdjust, ColorProp } from '../../types';
import { LOCAL_ADJUST_PROPS, defaultLocalAdjust, sampleChannel } from '../../model';
import { PERCENT_ENTRY, SliderRow, type KeyframeControl } from '../SliderRow';
import { MaskMotionControls } from './MaskMotionControls';

/**
 * Local adjustments: the Adjust sliders, on a mask.
 *
 * The whole point of the section is that it is not a different feature. A region
 * carries the same parameters as the clip's own grade, keyframable the same way,
 * on a shape with the same tools and the same motion tracker — so "darken the
 * sky", "warm the face" and "sharpen the subject only" are the grade you already
 * know, pointed at less of the frame.
 *
 * A list, like redactions, and for the same reason: a shot routinely wants two
 * of these, and each moves on its own. Only the region being worked on opens its
 * controls; the preview is where the placing actually happens.
 */

/**
 * The box sliders, for the placement the preview drag cannot do: a keyboard, and
 * the frame position read off another shot.
 */
const BOX_AXES: { prop: 'x' | 'y' | 'w' | 'h'; labelKey: ParseKeys; min: number }[] = [
  { prop: 'x', labelKey: 'inspector.mask.x', min: 0 },
  { prop: 'y', labelKey: 'inspector.mask.y', min: 0 },
  { prop: 'w', labelKey: 'inspector.mask.width', min: 0.02 },
  { prop: 'h', labelKey: 'inspector.mask.height', min: 0.02 },
];

/** Slider range of each parameter a region applies. Mirrors the global grade's. */
const RANGES: Record<string, { min: number; max: number }> = {
  brightness: { min: -1, max: 1 },
  contrast: { min: -1, max: 1 },
  saturation: { min: -1, max: 1 },
  temperature: { min: -1, max: 1 },
  tint: { min: -1, max: 1 },
  sharpen: { min: 0, max: 1 },
};

/** What a fresh region carries: where a double-clicked slider lands back on. */
const REGION_DEFAULTS = defaultLocalAdjust();

/** Two keyframe times within this many ms count as sitting on the same playhead. */
const ON_KEY_EPSILON_MS = 1;

/** The grade sliders of one region, each with its own keyframe diamond. */
function AdjustParams({ clip, adjust }: { clip: Clip; adjust: ClipLocalAdjust }) {
  const { t } = useTranslation();
  // Subscribed so the sliders track the value at the playhead as it moves: an
  // animated parameter reads its sampled value, not a stale constant.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const local = currentTimeMs - clip.timelineStartMs;

  const kf = (prop: ColorProp, label: string): KeyframeControl => {
    const ch = adjust.color[prop];
    const keys = Array.isArray(ch) ? ch : undefined;
    return {
      animated: !!keys,
      onKey: (keys ?? []).some((k) => Math.abs(k.t - local) < ON_KEY_EPSILON_MS),
      onToggle: () =>
        useStore
          .getState()
          .toggleClipLocalAdjustColorKeyframe(clip.id, adjust.id, prop, currentTimeMs),
      label: `${t('inspector.keyframe')} · ${label}`,
    };
  };

  return (
    <div className="space-y-2 border-t border-zinc-800/70 pt-2">
      <h4 className="text-2xs font-semibold uppercase tracking-wide text-zinc-600">
        {t('inspector.adjust')}
      </h4>
      {LOCAL_ADJUST_PROPS.map((prop) => {
        const { min, max } = RANGES[prop]!;
        const label = t(`inspector.adjust.${prop}` as ParseKeys);
        const ch = adjust.color[prop];
        return (
          <SliderRow
            key={prop}
            label={label}
            value={ch === undefined ? 0 : sampleChannel(ch, local)}
            min={min}
            max={max}
            step={0.01}
            format={(v) =>
              min < 0 ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}` : `${Math.round(v * 100)}%`
            }
            entry={PERCENT_ENTRY}
            // Identity for every graded parameter: the region changes nothing.
            defaultValue={0}
            onChange={(v) =>
              useStore
                .getState()
                .setClipLocalAdjustColorLive(clip.id, adjust.id, prop, v, currentTimeMs)
            }
            keyframe={kf(prop, label)}
          />
        );
      })}
    </div>
  );
}

export function LocalAdjustSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const regions = clip.localAdjusts ?? [];
  const selectedId = useStore((s) => s.selectedLocalAdjustId);
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const active = regions.find((a) => a.id === selectedId) ?? null;

  const add = () => {
    const st = useStore.getState();
    const id = st.addClipLocalAdjust(clip.id, defaultLocalAdjust());
    st.setSelectedLocalAdjustId(id);
  };

  /** Live edit of the open region — the slider gesture commits the undo step. */
  const set = (patch: Partial<ClipLocalAdjust>) => {
    if (active) useStore.getState().setClipLocalAdjust(clip.id, active.id, patch);
  };

  const commit = (patch: Partial<ClipLocalAdjust>) => {
    const st = useStore.getState();
    st.beginGesture();
    if (active) st.setClipLocalAdjust(clip.id, active.id, patch);
    st.endGesture();
  };

  return (
    // Named for the e2e that drives it: both this section and the clip's own
    // Adjust panel render a slider called "Brightness", so a spec asserting on
    // the regional one has to be able to say which panel it means.
    <div data-local-adjusts className="space-y-3 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.localAdjust')}
        </h3>
        <button
          type="button"
          onClick={add}
          aria-label={t('inspector.localAdjust.add.aria')}
          className="touch-hit flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-2xs font-medium text-zinc-200 hover:bg-zinc-700/70 active:bg-zinc-700"
        >
          <PlusIcon className="h-3 w-3" />
          {t('inspector.localAdjust.add')}
        </button>
      </div>

      {regions.length === 0 && (
        <p className="text-2xs text-zinc-600">{t('inspector.localAdjust.empty')}</p>
      )}

      {regions.map((region, i) => {
        const open = region.id === selectedId;
        return (
          <div
            key={region.id}
            className={`space-y-2 rounded-md border px-2 py-1.5 ${
              open ? 'border-amber-600/50 bg-amber-700/15' : 'border-zinc-800 bg-zinc-900/40'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-pressed={open}
                onClick={() =>
                  useStore.getState().setSelectedLocalAdjustId(open ? null : region.id)
                }
                className={`touch-hit min-w-0 flex-1 truncate text-left text-xs ${
                  region.disabled
                    ? 'text-zinc-600 line-through'
                    : open
                      ? 'text-amber-300'
                      : 'text-zinc-300'
                }`}
              >
                {t('inspector.localAdjust.region', { n: i + 1 })}
              </button>
              <button
                type="button"
                onClick={() =>
                  useStore
                    .getState()
                    .setClipLocalAdjust(clip.id, region.id, { disabled: !region.disabled })
                }
                title={t('inspector.localAdjust.toggle')}
                aria-label={t('inspector.localAdjust.toggle')}
                className="touch-hit rounded p-1 text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
              >
                {region.disabled ? (
                  <EyeClosedIcon className="h-3.5 w-3.5" />
                ) : (
                  <EyeOpenIcon className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => useStore.getState().removeClipLocalAdjust(clip.id, region.id)}
                title={t('inspector.localAdjust.remove')}
                aria-label={t('inspector.localAdjust.remove')}
                className="touch-hit rounded p-1 text-zinc-500 hover:bg-zinc-800/70 hover:text-red-300"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            {open && active && (
              <>
                <AdjustParams clip={clip} adjust={active} />

                <div className="flex items-center gap-2 border-t border-zinc-800/70 pt-2">
                  <span className="w-16 flex-none text-xs text-zinc-500">
                    {t('inspector.mask.shape')}
                  </span>
                  <div className="flex flex-1 gap-1">
                    {(['rect', 'ellipse'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={active.shape === s}
                        onClick={() => commit({ shape: s })}
                        className={`touch-hit flex-1 rounded px-2 py-1 text-2xs ${
                          active.shape === s
                            ? 'brand-on'
                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                        }`}
                      >
                        {t(`inspector.mask.${s}`)}
                      </button>
                    ))}
                    {/* Pen: the preview draw tool writes back into THIS region,
                        because it is the one that is open. */}
                    <button
                      type="button"
                      aria-pressed={active.shape === 'path'}
                      onClick={() => useStore.getState().setPreviewTool('pen')}
                      className={`touch-hit flex-1 rounded px-2 py-1 text-2xs ${
                        active.shape === 'path'
                          ? 'brand-on'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                      }`}
                    >
                      {t('inspector.mask.pen')}
                    </button>
                  </div>
                </div>
                {active.shape === 'path' && (
                  <p className="text-2xs text-zinc-600">{t('inspector.mask.pen.hint')}</p>
                )}
                {active.shape !== 'path' && (
                  <p className="text-2xs text-zinc-600">{t('inspector.localAdjust.dragHint')}</p>
                )}

                {active.shape !== 'path' &&
                  BOX_AXES.map((axis) => (
                    <SliderRow
                      key={axis.prop}
                      label={t(axis.labelKey)}
                      value={active[axis.prop]}
                      min={axis.min}
                      max={1}
                      step={0.005}
                      format={(v) => `${Math.round(v * 100)}%`}
                      entry={PERCENT_ENTRY}
                      defaultValue={REGION_DEFAULTS[axis.prop]}
                      onChange={(v) => set({ [axis.prop]: v })}
                    />
                  ))}

                <SliderRow
                  label={t('inspector.mask.feather')}
                  value={active.feather}
                  min={0}
                  max={0.3}
                  step={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  entry={PERCENT_ENTRY}
                  defaultValue={REGION_DEFAULTS.feather}
                  onChange={(v) => set({ feather: v })}
                />
                <label className="flex items-center justify-between text-xs text-zinc-400">
                  <span>{t('inspector.localAdjust.invert')}</span>
                  <input
                    type="checkbox"
                    checked={!!active.invert}
                    onChange={(e) => commit({ invert: e.target.checked })}
                    className="h-3.5 w-3.5 accent-amber-500"
                  />
                </label>

                <MaskMotionControls
                  clip={clip}
                  shape={active}
                  onLive={(prop, v) =>
                    useStore
                      .getState()
                      .setClipLocalAdjustMotionLive(clip.id, active.id, prop, v, currentTimeMs)
                  }
                  onToggleKey={(prop) =>
                    useStore
                      .getState()
                      .toggleClipLocalAdjustMotionKeyframe(clip.id, active.id, prop, currentTimeMs)
                  }
                  onMotion={(motion) =>
                    useStore.getState().setClipLocalAdjust(clip.id, active.id, { motion })
                  }
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
