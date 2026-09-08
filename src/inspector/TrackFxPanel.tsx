import { useTranslation } from 'react-i18next';
import { Cross2Icon, ResetIcon } from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { AudioFxType, Track } from '../types';
import { COLOR_PROPS, sampleChannel } from '../model';
import { PERCENT_ENTRY, SliderRow } from './SliderRow';
import { COLOR_RANGES, formatColorValue } from './colorRanges';
import { DEFAULT_FX_AMOUNT } from '../effects/catalog';
import { importLutFromDisk } from '../ui/lutActions';
import { trackDisplayName } from '../timeline/trackName';
import { Tooltip } from '../ui/Tooltip';

/**
 * The inspector, pointed at a LANE instead of a clip.
 *
 * A track's FX are the same two families a clip carries - a colour grade and an
 * effect chain - so this pane is deliberately the clip pane's controls with the
 * clip-only half taken out: no keyframes (a lane has no local time to animate
 * against, see `Track.color`), no transform, no fades. What is left is the part
 * that means something applied to a whole lane at once, and it reads like the
 * pane next to it because it IS the same knobs.
 *
 * Which half shows follows the lane's kind, not a toggle: a video lane grades,
 * an audio lane processes sound. A video lane's own sound is delegated to the
 * audio lane its clips are linked to, so offering it an effect chain would be a
 * row of dead knobs (see `trackAcceptsEffect`).
 */
export function TrackFxPanel({ track }: { track: Track }) {
  const { t } = useTranslation();
  const { setFxTrack, resetTrackColor } = useStore.getState();
  const ordinal = useStore((s) => {
    const list = s.project.tracks.filter((tr) => tr.kind === track.kind);
    return list.findIndex((tr) => tr.id === track.id) + 1;
  });
  const video = track.kind === 'video';

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
          {t('track.fx.title', { name: trackDisplayName(track, ordinal, t) })}
        </h2>
        {video && (
          <Tooltip label={t('inspector.reset')}>
            <button
              type="button"
              className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 pointer-coarse:p-2.5"
              aria-label={t('inspector.reset')}
              onClick={() => resetTrackColor(track.id)}
            >
              <ResetIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t('inspector.close')}>
          <button
            type="button"
            className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 pointer-coarse:p-2.5"
            aria-label={t('inspector.close')}
            onClick={() => setFxTrack(null)}
          >
            <Cross2Icon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      {/* One line saying WHERE the effect lands. A lane grade and a clip grade
          are the same sliders, and the only thing that tells them apart is that
          this one sees the cut already assembled. */}
      <p className="text-2xs leading-snug text-zinc-500">
        {t(video ? 'track.fx.hint.video' : 'track.fx.hint.audio')}
      </p>
      {video ? <TrackGrade track={track} /> : <TrackAudioFx track={track} />}
    </>
  );
}

/** The lane's colour grade: the same LUT and the same parameters a clip has. */
function TrackGrade({ track }: { track: Track }) {
  const { t } = useTranslation();
  const { setTrackColorLive, setTrackLut, setTrackLutIntensity } = useStore.getState();
  const luts = useStore((s) => s.project.luts) ?? [];
  const lut = track.color?.lut;

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {t('inspector.adjust')}
      </h3>
      <div className="flex items-center gap-2">
        <span className="w-16 flex-none text-xs text-zinc-500">{t('inspector.lut')}</span>
        <select
          value={lut?.id ?? ''}
          onChange={(e) => setTrackLut(track.id, e.target.value || null)}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-brand-500"
        >
          <option value="">{t('inspector.lut.none')}</option>
          {luts.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="touch-hit flex-none rounded-md border border-zinc-700 px-2 py-1 text-2xs text-zinc-300 hover:bg-zinc-800/70 active:bg-zinc-800"
          onClick={() => importLutFromDisk((id) => setTrackLut(track.id, id))}
          title={t('inspector.lut.import')}
        >
          {t('inspector.lut.import')}
        </button>
      </div>
      {lut && (
        <SliderRow
          label={t('inspector.lut.intensity')}
          value={lut.intensity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          entry={PERCENT_ENTRY}
          defaultValue={1}
          onChange={(v) => setTrackLutIntensity(track.id, v)}
        />
      )}
      {COLOR_PROPS.map((prop) => {
        const { min, max } = COLOR_RANGES[prop];
        return (
          <SliderRow
            key={prop}
            label={t(`inspector.adjust.${prop}`)}
            // A lane's channels are constants, so they read at local time 0 -
            // the one instant `resolveTrackColor` samples them at.
            value={sampleChannel(track.color?.[prop] ?? 0, 0)}
            min={min}
            max={max}
            step={0.01}
            format={(v) => formatColorValue(min, v)}
            entry={PERCENT_ENTRY}
            defaultValue={0}
            onChange={(v) => setTrackColorLive(track.id, prop, v)}
          />
        );
      })}
    </div>
  );
}

/** The lane's effect chain, processing the sum of its clips. */
function TrackAudioFx({ track }: { track: Track }) {
  const { t } = useTranslation();
  const { setTrackAudioFxAmount, removeTrackAudioFx } = useStore.getState();
  const chain = track.audioFx ?? [];

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {t('inspector.audioFx')}
      </h3>
      {chain.length === 0 ? (
        <p className="text-2xs leading-snug text-zinc-500">{t('track.fx.empty')}</p>
      ) : (
        chain.map((fx) => (
          <TrackFxRow
            key={fx.type}
            type={fx.type}
            amount={fx.amount}
            onAmount={(v) => setTrackAudioFxAmount(track.id, fx.type, v)}
            onRemove={() => removeTrackAudioFx(track.id, fx.type)}
          />
        ))
      )}
    </div>
  );
}

/** One effect of the chain: its intensity, and a way off. Mirrors AudioSection. */
function TrackFxRow({
  type,
  amount,
  onAmount,
  onRemove,
}: {
  type: AudioFxType;
  amount: number;
  onAmount: (v: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const name = t(`inspector.audioFx.${type}`);
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <SliderRow
          label={name}
          value={amount}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          entry={PERCENT_ENTRY}
          defaultValue={DEFAULT_FX_AMOUNT}
          onChange={onAmount}
        />
      </div>
      <button
        type="button"
        className="touch-hit flex-none rounded p-1 text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-300 active:bg-zinc-800 pointer-coarse:p-2"
        onClick={onRemove}
        aria-label={t('inspector.audioFx.remove', { name })}
        title={t('inspector.audioFx.remove', { name })}
      >
        <Cross2Icon className="h-3 w-3" />
      </button>
    </div>
  );
}
