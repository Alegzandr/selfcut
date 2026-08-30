/**
 * Clip speed: the flat rate, and the ramp that makes it vary.
 *
 * The ramp is born here rather than in a right-click submenu, which is the one
 * thing Vegas's velocity envelope gets wrong: it is invisible until inserted,
 * so nobody finds it. Speed is what an editor comes to this control for, and a
 * ramp is a kind of speed, so it lives one row below the presets, drawn as the
 * curve it will produce. One click lays it down and it appears on the clip,
 * where it is edited.
 *
 * The scalar and the ramp are not rivals. Ramp values are multipliers OF
 * `clip.speed` (see `src/model/velocity.ts`), so pressing 2x on a ramped clip
 * scales the whole curve and keeps its shape - nothing is destroyed, and there
 * is no dialog warning that it would be.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LockClosedIcon, LockOpen1Icon } from '@radix-ui/react-icons';
import { useStore } from '../../store/store';
import { ToggleButton } from '../../ui/ToggleButton';
import { Clip } from '../../types';
import {
  frozenTailMs,
  hasVelocity,
  rampPresetKeys,
  rampRange,
  unreachedSourceMs,
  sampleChannel,
  type RampPresetId,
} from '../../model';
import { rateToLinePos } from '../../timeline/velocityLine';
import { RampEditor } from './RampEditor';
import { CLIP_COLORS } from '../../lib/palette';
import { seconds, speedX } from '../format';

const PRESET_IDS: RampPresetId[] = ['slowDown', 'speedUp', 'highlight', 'whip'];

/**
 * A preset drawn as the curve it produces, on the same logarithmic axis the
 * clip's line uses. The button IS the preview: four names alone would say
 * nothing, and four generic icons would say less.
 */
function PresetCurve({ preset }: { preset: RampPresetId }) {
  const keys = rampPresetKeys(preset, 1);
  const steps = 28;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const y = 2 + (1 - rateToLinePos(sampleChannel(keys, p))) * 16;
    points.push(`${(p * 44).toFixed(1)},${y.toFixed(2)}`);
  }
  return (
    <svg viewBox="0 0 44 20" className="h-5 w-11" aria-hidden focusable="false">
      <line
        x1={0}
        y1={10}
        x2={44}
        y2={10}
        stroke={CLIP_COLORS.velocityUnity}
        strokeWidth={1}
        strokeDasharray="2 2"
      />
      <path
        d={`M${points.join(' L')}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SpeedControl({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClipCommitted } = useStore.getState();
  const [text, setText] = useState(String(clip.speed));
  useEffect(() => setText(String(clip.speed)), [clip.id, clip.speed]);

  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (isFinite(v) && v >= 0.1 && v <= 8) updateClipCommitted(clip.id, { speed: v });
    else setText(String(clip.speed));
  };

  const ramped = hasVelocity(clip);
  // Only timed video has a media clock to ramp. A still or a generated clip
  // stretches freely under a plain trim already, and an audio clip would be
  // silenced by the very ramp applied to it.
  const canRamp = clip.kind === 'media';
  const range = ramped ? rampRange(clip) : null;
  // Below unity somewhere: the only case where how frames are sampled changes
  // anything, so the control appears exactly when it means something.
  const canBlend = ramped ? range!.min < 1 : clip.speed < 1;

  // Only a locked ramp can lose anything: unlocked, the clip stretches to fit
  // whatever the curve asks for and the whole shot plays.
  const unreached = ramped ? unreachedSourceMs(clip) : 0;
  const frozen = ramped ? frozenTailMs(clip) : 0;

  const applyPreset = (preset: RampPresetId) => {
    const span = clip.sourceOutMs - clip.sourceInMs;
    updateClipCommitted(clip.id, { velocity: rampPresetKeys(preset, span) });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-xs text-zinc-400">
        <span className="w-16 flex-none pt-1.5">{t('inspector.speed')}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {[0.5, 1, 1.5, 2].map((s) => (
            <ToggleButton
              key={s}
              active={clip.speed === s}
              onClick={() => updateClipCommitted(clip.id, { speed: s })}
            >
              {s}×
            </ToggleButton>
          ))}
          <div className="flex items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              min={0.1}
              max={8}
              step={0.1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="w-14 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-zinc-200 outline-none focus:border-brand-500"
            />
            <span>×</span>
          </div>
        </div>
      </div>

      {canRamp && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-zinc-400">{t('inspector.speed.ramp')}</span>
            {range && (
              <span className="truncate text-2xs tabular-nums text-zinc-500">
                {t('inspector.speed.range', {
                  min: speedX(range.min),
                  max: speedX(range.max),
                })}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {PRESET_IDS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => applyPreset(preset)}
                className="touch-hit flex items-center gap-2 rounded-md border border-zinc-700/70 bg-zinc-800/60 px-2 py-1.5 text-2xs text-zinc-300 outline-none transition-colors hover:border-zinc-600 hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand-500 active:bg-zinc-700"
              >
                <PresetCurve preset={preset} />
                <span className="min-w-0 flex-1 truncate text-left leading-none">
                  {t(`inspector.speed.ramp.${preset}` as 'inspector.speed.ramp.slowDown')}
                </span>
              </button>
            ))}
          </div>

          {ramped && (
            <>
              <RampEditor clip={clip} />
              <div className="flex flex-wrap items-center gap-1.5">
                <ToggleButton
                  active={!!clip.velocityLocked}
                  aria-pressed={!!clip.velocityLocked}
                  onClick={() =>
                    updateClipCommitted(clip.id, { velocityLocked: !clip.velocityLocked })
                  }
                  className="flex items-center gap-1.5 text-xs"
                >
                  {clip.velocityLocked ? (
                    <LockClosedIcon className="h-3 w-3" />
                  ) : (
                    <LockOpen1Icon className="h-3 w-3" />
                  )}
                  {t('inspector.speed.lock')}
                </ToggleButton>
                <button
                  type="button"
                  onClick={() =>
                    updateClipCommitted(clip.id, { velocity: undefined, velocityLocked: undefined })
                  }
                  className="touch-hit rounded-md px-2 py-1 text-xs text-zinc-400 outline-none hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-brand-500 pointer-coarse:px-3 pointer-coarse:py-1.5"
                >
                  {t('inspector.speed.ramp.clear')}
                </button>
              </div>
              {clip.velocityLocked && (
                <p className="text-2xs leading-snug text-zinc-500">
                  {t('inspector.speed.lock.hint')}{' '}
                  {/* What the lock actually costs on THIS clip, in seconds, so
                      it is a fact rather than a warning about a possibility. */}
                  {unreached > 250 && t('inspector.speed.unreached', { time: seconds(unreached) })}
                  {frozen > 250 && t('inspector.speed.frozen', { time: seconds(frozen) })}
                </p>
              )}
              <p className="text-2xs leading-snug text-zinc-500">
                {t('inspector.speed.mutedAudio')}
              </p>
            </>
          )}
        </div>
      )}

      {canBlend && (
        <div className="flex items-start gap-2 text-xs text-zinc-400">
          <span className="w-16 flex-none pt-1.5">{t('inspector.speed.frames')}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-1.5">
              {(['smooth', 'sharp'] as const).map((mode) => (
                <ToggleButton
                  key={mode}
                  active={(clip.frameBlend ?? 'smooth') === mode}
                  onClick={() => updateClipCommitted(clip.id, { frameBlend: mode })}
                >
                  {t(`inspector.speed.frames.${mode}` as 'inspector.speed.frames.smooth')}
                </ToggleButton>
              ))}
            </div>
            <p className="text-2xs leading-snug text-zinc-500">
              {t('inspector.speed.frames.hint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
