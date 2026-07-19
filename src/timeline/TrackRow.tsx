import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Eye, EyeOff, Film, Music2, Trash2, Volume2, VolumeX } from 'lucide-react';
import { Track } from '../types';
import { trackCrossfades } from '../model';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { ClipView } from './ClipView';
import { TrackMeter } from './TrackMeter';
import { TRACK_HEADER_WIDTH_PX, TRACK_HEIGHT_PX } from '../app/config';
import { gainDb } from '../inspector/format';
import { faderToGain, gainToFader } from '../lib/gain';

interface Props {
  track: Track;
  pxPerMs: number;
}

export const TrackRow = memo(function TrackRow({ track, pxPerMs }: Props) {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  // Set while the volume slider is being dragged: the native `title` tooltip
  // freezes on its first value, so the live dB read-out gets its own badge.
  const [draggingVolume, setDraggingVolume] = useState(false);
  const { toggleTrackMuted, toggleTrackHidden, moveTrack, removeTrack, updateTrack, beginGesture, endGesture } =
    useStore.getState();

  const btn =
    'touch-hit flex h-4.5 w-4.5 items-center justify-center rounded text-zinc-500 active:bg-zinc-700 pointer-coarse:h-7 pointer-coarse:w-7';
  const slider = 'slider-thin w-full min-w-0 cursor-ew-resize';

  const xfades = trackCrossfades(track.clips);

  return (
    <div
      className={`relative border-b border-zinc-800/80 ${track.hidden ? 'opacity-40' : ''}`}
      style={{ height: TRACK_HEIGHT_PX }}
      data-rowbg
      data-track-id={track.id}
    >
      {/* Sticky track header: buttons + (desktop) volume/opacity sliders and level meter */}
      <div
        className={`sticky left-0 z-10 flex h-full items-center gap-1 border-r border-zinc-800 bg-zinc-900 py-0.5 ${coarse ? 'w-11 justify-center' : 'px-1'}`}
        style={coarse ? undefined : { width: TRACK_HEADER_WIDTH_PX }}
        onContextMenu={(e) => {
          if (coarse) return; // Desktop only.
          e.preventDefault();
          e.stopPropagation();
          useStore.getState().openContextMenu(e.clientX, e.clientY, {
            kind: 'track',
            trackId: track.id,
          });
        }}
      >
        <div className="flex flex-none flex-col items-center justify-center gap-0.5">
          <div className="flex items-center gap-0.5">
            {track.kind === 'video' ? (
              <Film className="h-3 w-3 text-sky-400" />
            ) : (
              <Music2 className="h-3 w-3 text-emerald-400" />
            )}
            <Tooltip label={t('track.delete')}>
              <button className={btn} onClick={() => removeTrack(track.id)}>
                <Trash2 className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip label={t('track.mute')}>
              <button className={btn} onClick={() => toggleTrackMuted(track.id)}>
                {track.muted ? (
                  <VolumeX className="h-3 w-3 text-red-400" />
                ) : (
                  <Volume2 className="h-3 w-3" />
                )}
              </button>
            </Tooltip>
            {track.kind === 'video' ? (
              <Tooltip label={t('track.hide')}>
                <button className={btn} onClick={() => toggleTrackHidden(track.id)}>
                  {track.hidden ? <EyeOff className="h-3 w-3 text-red-400" /> : <Eye className="h-3 w-3" />}
                </button>
              </Tooltip>
            ) : (
              <span className="h-4.5 w-4.5" />
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip label={t('track.moveUp')}>
              <button className={btn} onClick={() => moveTrack(track.id, -1)}>
                <ChevronUp className="h-3 w-3" />
              </button>
            </Tooltip>
            <Tooltip label={t('track.moveDown')}>
              <button className={btn} onClick={() => moveTrack(track.id, 1)}>
                <ChevronDown className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
        </div>

        {!coarse && (
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 pr-0.5">
            <div className="relative">
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={gainToFader(track.volume ?? 1)}
                className={`${slider} ${track.kind === 'video' ? 'text-sky-500' : 'text-emerald-500'}`}
                title={t('track.volume', { db: gainDb(track.volume ?? 1) })}
                onPointerDown={() => {
                  setDraggingVolume(true);
                  beginGesture();
                }}
                onPointerUp={() => {
                  setDraggingVolume(false);
                  endGesture();
                }}
                onPointerCancel={() => setDraggingVolume(false)}
                onBlur={() => setDraggingVolume(false)}
                onChange={(e) => updateTrack(track.id, { volume: faderToGain(Number(e.target.value)) })}
                onDoubleClick={() => updateTrack(track.id, { volume: 1 })}
              />
              {draggingVolume && (
                <div className="pointer-events-none absolute -top-4 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-950/85 px-1 py-0.5 font-mono text-[10px] leading-tight text-zinc-100 shadow">
                  {gainDb(track.volume ?? 1)}
                </div>
              )}
            </div>
            {track.kind === 'video' && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={track.opacity ?? 1}
                className={`${slider} text-zinc-400`}
                title={t('track.opacity', { pct: Math.round((track.opacity ?? 1) * 100) })}
                onPointerDown={beginGesture}
                onPointerUp={endGesture}
                onChange={(e) => updateTrack(track.id, { opacity: Number(e.target.value) })}
                onDoubleClick={() => updateTrack(track.id, { opacity: 1 })}
              />
            )}
            <TrackMeter trackId={track.id} />
          </div>
        )}
      </div>

      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          trackKind={track.kind}
          pxPerMs={pxPerMs}
          xfadeInMs={xfades.get(clip.id)?.inMs ?? 0}
          xfadeOutMs={xfades.get(clip.id)?.outMs ?? 0}
        />
      ))}
    </div>
  );
});
