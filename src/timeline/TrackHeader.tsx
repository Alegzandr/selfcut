import { memo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  // Set while a slider is being dragged: the native `title` tooltip freezes on
  // its first value, so the live read-out gets its own badge.
  // Portalled and viewport-positioned rather than absolute inside the row: the
  // badge sits above the slider, and on the first track that lands outside the
  // header pane's `overflow-hidden`, which clipped it away entirely.
  const volumeRef = useRef<HTMLInputElement>(null);
  const opacityRef = useRef<HTMLInputElement>(null);
  const [badgeAt, setBadgeAt] = useState<{ left: number; top: number; kind: 'volume' | 'opacity' } | null>(null);
  const showBadge = (el: HTMLInputElement | null, kind: 'volume' | 'opacity') => {
    const r = el?.getBoundingClientRect();
    if (r) setBadgeAt({ left: r.left + r.width / 2, top: r.top - 6, kind });
  };
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
              {/* Stable name + aria-pressed: the tooltip flips with the action
                  ("Unlock track") but a toggle reads better as one name whose
                  pressed state carries the on/off - same for mute and hide. */}
              <button
                className={btn}
                aria-label={t('track.lock')}
                aria-pressed={!!track.locked}
                onClick={() => toggleTrackLocked(track.id)}
              >
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
              <button
                className={btn}
                aria-label={t('track.mute')}
                aria-pressed={!!track.muted}
                onClick={() => toggleTrackMuted(track.id)}
              >
                {track.muted ? (
                  <VolumeX className="h-3 w-3 text-red-400" />
                ) : (
                  <Volume2 className="h-3 w-3" />
                )}
              </button>
            </Tooltip>
            {track.kind === 'video' ? (
              <Tooltip label={t(track.hidden ? 'track.show' : 'track.hide')}>
                <button
                  className={btn}
                  aria-label={t('track.hide')}
                  aria-pressed={!!track.hidden}
                  onClick={() => toggleTrackHidden(track.id)}
                >
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
                ref={volumeRef}
                type="range"
                min={0}
                max={1}
                step={DB_STEP_FADER}
                value={gainToFader(track.volume ?? 1)}
                className={`${slider} ${track.kind === 'video' ? 'text-sky-500' : 'text-emerald-500'}`}
                title={t('track.volume', { db: gainDb(track.volume ?? 1) })}
                aria-label={t('a11y.track.volume')}
                // The range's raw value is a fader position (0..1): meaningless
                // read aloud, so speak the dB figure the badge shows instead.
                aria-valuetext={gainDb(track.volume ?? 1)}
                onPointerDown={() => {
                  showBadge(volumeRef.current, 'volume');
                  beginGesture();
                }}
                onPointerUp={() => {
                  setBadgeAt(null);
                  endGesture();
                }}
                onPointerCancel={() => setBadgeAt(null)}
                onBlur={() => setBadgeAt(null)}
                onChange={(e) =>
                  updateTrack(track.id, { volume: faderToGainStepped(Number(e.target.value)) })
                }
                onDoubleClick={() => updateTrack(track.id, { volume: 1 })}
                onContextMenu={volumeEntry.onContextMenu}
              />
              {volumeEntry.entry}
            </div>
            {track.kind === 'video' && (
              <input
                ref={opacityRef}
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={track.opacity ?? 1}
                className={`${slider} text-zinc-400`}
                title={t('track.opacity', { pct: Math.round((track.opacity ?? 1) * 100) })}
                aria-label={t('a11y.track.opacity')}
                aria-valuetext={`${Math.round((track.opacity ?? 1) * 100)}%`}
                onPointerDown={() => {
                  showBadge(opacityRef.current, 'opacity');
                  beginGesture();
                }}
                onPointerUp={() => {
                  setBadgeAt(null);
                  endGesture();
                }}
                onPointerCancel={() => setBadgeAt(null)}
                onBlur={() => setBadgeAt(null)}
                onChange={(e) => updateTrack(track.id, { opacity: Number(e.target.value) })}
                onDoubleClick={() => updateTrack(track.id, { opacity: 1 })}
              />
            )}
            {badgeAt &&
              createPortal(
                <div
                  className="pointer-events-none fixed z-[200] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-zinc-950/85 px-1 py-0.5 font-mono text-[10px] leading-tight text-zinc-100 shadow"
                  style={{ left: badgeAt.left, top: badgeAt.top }}
                >
                  {badgeAt.kind === 'volume'
                    ? gainDb(track.volume ?? 1)
                    : `${Math.round((track.opacity ?? 1) * 100)}%`}
                </div>,
                document.body,
              )}
            <TrackMeter trackId={track.id} />
          </div>
        )}
      </div>
    </div>
  );
});
