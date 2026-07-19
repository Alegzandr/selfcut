import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Eye, EyeOff, Lock, LockOpen, Trash2, Volume2, VolumeX } from 'lucide-react';
import { Track } from '../types';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { TrackMeter } from './TrackMeter';

import { gainDb } from '../inspector/format';
import { DB_STEP_FADER, faderToGainStepped, gainToFader } from '../lib/gain';
import { useVolumeEntry } from '../ui/VolumeEntry';

interface Props {
  track: Track;
}

/**
 * One row of the fixed header pane, aligned with its {@link TrackRow} in the
 * scroller. It lives outside the scroller, so nothing on the timeline can ever
 * paint over it - no sticky, no z-index, no opaque-background trick.
 */
export const TrackHeader = memo(function TrackHeader({ track }: Props) {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  // Set while the volume slider is being dragged: the native `title` tooltip
  // freezes on its first value, so the live dB read-out gets its own badge.
  const [draggingVolume, setDraggingVolume] = useState(false);
  const trackHeightPx = useStore((s) => s.trackHeightPx);
  const { toggleTrackMuted, toggleTrackHidden, toggleTrackLocked, moveTrack, removeTrack, updateTrack, beginGesture, endGesture } =
    useStore.getState();

  const btn =
    'touch-hit flex h-4.5 w-4.5 items-center justify-center rounded text-zinc-500 active:bg-zinc-700 pointer-coarse:h-7 pointer-coarse:w-7';
  const slider = 'slider-thin w-full min-w-0 cursor-ew-resize';
  const volumeEntry = useVolumeEntry({
    gain: track.volume ?? 1,
    onCommit: (volume) => {
      // One undo step, the same as a drag of the fader.
      beginGesture();
      updateTrack(track.id, { volume });
      endGesture();
    },
  });

  return (
    <div
      className={`flex items-center gap-1 border-b border-zinc-800/80 bg-zinc-900 py-0.5 ${coarse ? 'justify-center' : 'px-1'}`}
      style={{ height: trackHeightPx }}
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
      {/* Only the controls dim on a hidden track: the pane itself must stay
          opaque, it is what separates the header column from the timeline. */}
      <div className={`flex w-full items-center gap-1 ${track.hidden ? 'opacity-40' : ''}`}>
        <div className="flex flex-none flex-col items-center justify-center gap-0.5">
          <div className="flex items-center gap-0.5">
            {/* The lock takes the slot the type icon used to hold: clips are
                already colour-coded by kind, so that icon only repeated what
                the row itself says, while locking had nowhere to live. */}
            <Tooltip label={t(track.locked ? 'track.unlock' : 'track.lock')}>
              <button className={btn} onClick={() => toggleTrackLocked(track.id)}>
                {track.locked ? (
                  <Lock className="h-3 w-3 text-amber-400" />
                ) : (
                  <LockOpen className="h-3 w-3" />
                )}
              </button>
            </Tooltip>
            <Tooltip label={t('track.delete')}>
              <button className={btn} onClick={() => removeTrack(track.id)}>
                <Trash2 className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
          <div className="flex items-center gap-0.5">
            {/* The tooltip names the action, not the state: the icon already
                shows the state, and "Mute track" on a muted track is a lie. */}
            <Tooltip label={t(track.muted ? 'track.unmute' : 'track.mute')}>
              <button className={btn} onClick={() => toggleTrackMuted(track.id)}>
                {track.muted ? (
                  <VolumeX className="h-3 w-3 text-red-400" />
                ) : (
                  <Volume2 className="h-3 w-3" />
                )}
              </button>
            </Tooltip>
            {track.kind === 'video' ? (
              <Tooltip label={t(track.hidden ? 'track.show' : 'track.hide')}>
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
                step={DB_STEP_FADER}
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
                onChange={(e) =>
                  updateTrack(track.id, { volume: faderToGainStepped(Number(e.target.value)) })
                }
                onDoubleClick={() => updateTrack(track.id, { volume: 1 })}
                onContextMenu={volumeEntry.onContextMenu}
              />
              {volumeEntry.entry}
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
    </div>
  );
});
