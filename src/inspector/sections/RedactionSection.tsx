import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import {
  EyeClosedIcon,
  EyeOpenIcon,
  PlusIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../../store/store';
import { Clip, ClipRedaction, RedactionMode } from '../../types';
import { defaultRedaction } from '../../model';
import { PERCENT_ENTRY, SliderRow } from '../SliderRow';
import { MaskMotionControls } from './MaskMotionControls';

/**
 * Redaction regions: the blur-this-face tool.
 *
 * A list rather than a single control, because one shot routinely has several
 * things to hide and each of them moves on its own. Only the region being
 * worked on opens its controls — a stack of four fully-expanded shape editors is
 * unreadable, and the preview is where the placing actually happens anyway.
 *
 * Unlike the mask above, a region hides in place: the clip stays whole, nothing
 * behind it is touched, and there is no duplicate on a track above to keep in
 * sync when the cut changes.
 */

const MODES: RedactionMode[] = ['blur', 'pixelate'];

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

export function RedactionSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const regions = clip.redactions ?? [];
  const selectedId = useStore((s) => s.selectedRedactionId);
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const active = regions.find((r) => r.id === selectedId) ?? null;

  const add = () => {
    const st = useStore.getState();
    const id = st.addClipRedaction(clip.id, defaultRedaction());
    st.setSelectedRedactionId(id);
  };

  /** Live edit of the open region — the slider gesture commits the undo step. */
  const set = (patch: Partial<ClipRedaction>) => {
    if (active) useStore.getState().setClipRedaction(clip.id, active.id, patch);
  };

  const commit = (patch: Partial<ClipRedaction>) => {
    const st = useStore.getState();
    st.beginGesture();
    if (active) st.setClipRedaction(clip.id, active.id, patch);
    st.endGesture();
  };

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.redaction')}
        </h3>
        <button
          type="button"
          onClick={add}
          className="touch-hit flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-2xs font-medium text-zinc-200 hover:bg-zinc-700/70 active:bg-zinc-700"
        >
          <PlusIcon className="h-3 w-3" />
          {t('inspector.redaction.add')}
        </button>
      </div>

      {regions.length === 0 && <p className="text-2xs text-zinc-600">{t('inspector.redaction.empty')}</p>}

      {regions.map((region, i) => {
        const open = region.id === selectedId;
        return (
          <div
            key={region.id}
            className={`space-y-2 rounded-md border px-2 py-1.5 ${
              open ? 'border-brand-600/50 bg-brand-700/15' : 'border-zinc-800 bg-zinc-900/40'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-pressed={open}
                onClick={() => useStore.getState().setSelectedRedactionId(open ? null : region.id)}
                className={`touch-hit min-w-0 flex-1 truncate text-left text-xs ${
                  region.disabled ? 'text-zinc-600 line-through' : open ? 'text-brand-300' : 'text-zinc-300'
                }`}
              >
                {t('inspector.redaction.region', { n: i + 1 })} ·{' '}
                <span className="text-zinc-500">{t(`inspector.redaction.mode.${region.mode}`)}</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  useStore.getState().setClipRedaction(clip.id, region.id, { disabled: !region.disabled })
                }
                title={t('inspector.redaction.toggle')}
                aria-label={t('inspector.redaction.toggle')}
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
                onClick={() => useStore.getState().removeClipRedaction(clip.id, region.id)}
                title={t('inspector.redaction.remove')}
                aria-label={t('inspector.redaction.remove')}
                className="touch-hit rounded p-1 text-zinc-500 hover:bg-zinc-800/70 hover:text-red-300"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            {open && active && (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-16 flex-none text-xs text-zinc-500">
                    {t('inspector.redaction.mode')}
                  </span>
                  <div className="flex flex-1 gap-1">
                    {MODES.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={active.mode === mode}
                        onClick={() => commit({ mode })}
                        className={`touch-hit flex-1 rounded px-2 py-1 text-2xs ${
                          active.mode === mode
                            ? 'brand-on'
                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
                        }`}
                      >
                        {t(`inspector.redaction.mode.${mode}`)}
                      </button>
                    ))}
                  </div>
                </div>

                <SliderRow
                  label={t('inspector.redaction.amount')}
                  value={active.amount}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  entry={PERCENT_ENTRY}
                  onChange={(v) => set({ amount: v })}
                />

                <div className="flex items-center gap-2">
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
                  <p className="text-2xs text-zinc-600">{t('inspector.redaction.dragHint')}</p>
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
                  onChange={(v) => set({ feather: v })}
                />
                <label className="flex items-center justify-between text-xs text-zinc-400">
                  <span>{t('inspector.redaction.invert')}</span>
                  <input
                    type="checkbox"
                    checked={!!active.invert}
                    onChange={(e) => commit({ invert: e.target.checked })}
                    className="h-3.5 w-3.5 accent-brand-500"
                  />
                </label>

                <MaskMotionControls
                  clip={clip}
                  shape={active}
                  onLive={(prop, v) =>
                    useStore
                      .getState()
                      .setClipRedactionMotionLive(clip.id, active.id, prop, v, currentTimeMs)
                  }
                  onToggleKey={(prop) =>
                    useStore
                      .getState()
                      .toggleClipRedactionMotionKeyframe(clip.id, active.id, prop, currentTimeMs)
                  }
                  onMotion={(motion) =>
                    useStore.getState().setClipRedaction(clip.id, active.id, { motion })
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
