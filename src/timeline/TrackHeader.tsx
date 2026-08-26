import { memo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  BlendingModeIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ComponentInstanceIcon,
  DotsHorizontalIcon,
  EyeClosedIcon,
  EyeOpenIcon,
  LockClosedIcon,
  LockOpen1Icon,
  SpeakerLoudIcon,
  SpeakerOffIcon,
} from '@radix-ui/react-icons';
import { Track } from '../types';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { TrackMeter } from './TrackMeter';

import { gainDb } from '../inspector/format';
import { DB_STEP_FADER, faderToGainStepped, gainToFader } from '../lib/gain';
import { useVolumeEntry } from '../ui/VolumeEntry';
import { KEYFRAME_LANE_HEIGHT_PX, KEYFRAME_LANES_GAP_PX, lanesHeightPx, trackLanes } from './trackHeight';
import { KeyframeProp } from '../types';
import type { ParseKeys } from 'i18next';

interface Props {
  track: Track;
  /** 1-based position among the tracks of its kind, for the "V1" / "A2" name. */
  ordinal: number;
}

/**
 * Row heights, in px, below which each secondary line of the header stops being
 * drawn. A minimised track keeps its identity line and its toggles - the deal
 * Vegas gives a collapsed track - and what it drops stays reachable from the
 * overflow menu or the inspector.
 */
const VOLUME_MIN_HEIGHT_PX = 40;
const METER_MIN_HEIGHT_PX = 52;
const OPACITY_MIN_HEIGHT_PX = 62;
/** Coarse pointers get 28px buttons: below this only the overflow one fits. */
const COARSE_MUTE_MIN_HEIGHT_PX = 60;

/**
 * One row of the fixed header pane, aligned with its {@link TrackRow} in the
 * scroller. It lives outside the scroller, so nothing on the timeline can ever
 * paint over it - no sticky, no z-index, no opaque-background trick.
 *
 * Two lines, not a grid of look-alike glyphs: the first says *which* track this
 * is and what state it is in, the rest are the faders, each prefixed by the icon
 * of the thing it moves so two identical bars can never be mistaken for each
 * other. Reorder and delete were pulled out of the header entirely: they are
 * one-shot actions that read as toggles when they sit in the same cluster, and
 * the menu behind the overflow button already carried both.
 */
export const TrackHeader = memo(function TrackHeader({ track, ordinal }: Props) {
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
  const expanded = useStore((s) => s.expandedTrackIds.includes(track.id));
  const lanes = trackLanes(track);
  const {
    toggleTrackMuted,
    toggleTrackHidden,
    toggleTrackLocked,
    toggleTrackExpanded,
    updateTrack,
    beginGesture,
    endGesture,
    openContextMenu,
  } = useStore.getState();

  const video = track.kind === 'video';
  const showVolume = !coarse && trackHeightPx >= VOLUME_MIN_HEIGHT_PX;
  const showMeter = !coarse && trackHeightPx >= METER_MIN_HEIGHT_PX;
  const showOpacity = !coarse && video && trackHeightPx >= OPACITY_MIN_HEIGHT_PX;

  const btn =
    'touch-hit flex h-4.5 w-4.5 flex-none items-center justify-center rounded text-zinc-500 hover:bg-zinc-700/60 active:bg-zinc-700 pointer-coarse:h-7 pointer-coarse:w-7';
  // An engaged toggle also gets a filled slot: colour alone reads as decoration
  // at this size, the plate underneath reads as "pressed".
  const btnOn = `${btn} bg-zinc-800`;
  // One neutral knob colour for every fader in the app: the track's kind is
  // already said by its icon and its lane, so tinting the slider only competed
  // with it.
  const slider = 'slider-thin w-full min-w-0 cursor-ew-resize text-zinc-300';
  const faderIcon = 'h-3 w-3 flex-none text-zinc-500';
  const volumeEntry = useVolumeEntry({
    gain: track.volume ?? 1,
    onCommit: (volume) => {
      // One undo step, the same as a drag of the fader.
      beginGesture();
      updateTrack(track.id, { volume });
      endGesture();
    },
  });

  const openMenu = (x: number, y: number) =>
    openContextMenu(x, y, { kind: 'track', trackId: track.id });

  /** Overflow: the rows of the right-click menu, reachable by touch too. */
  const moreButton = (
    <Tooltip label={t('track.more')}>
      <button
        className={btn}
        aria-label={t('track.more')}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.right, r.bottom + 4);
        }}
      >
        <DotsHorizontalIcon className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );

  const muteButton = (
    // The tooltip names the action, not the state: the icon already shows the
    // state, and "Mute track" on a muted track is a lie.
    <Tooltip label={t(track.muted ? 'track.unmute' : 'track.mute')}>
      {/* Stable name + aria-pressed: the tooltip flips with the action
          ("Unmute track") but a toggle reads better as one name whose pressed
          state carries the on/off - same for hide and lock. */}
      <button
        className={track.muted ? btnOn : btn}
        aria-label={t('track.mute')}
        aria-pressed={!!track.muted}
        onClick={() => toggleTrackMuted(track.id)}
      >
        {track.muted ? (
          <SpeakerOffIcon className="h-3.5 w-3.5 text-red-400" />
        ) : (
          <SpeakerLoudIcon className="h-3.5 w-3.5" />
        )}
      </button>
    </Tooltip>
  );

  return (
    <div
      className="flex flex-col border-b border-zinc-800/80 bg-zinc-900"
      onContextMenu={(e) => {
        if (coarse) return; // Desktop only.
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
    >
      {/* Only the controls dim on a hidden track: the pane itself must stay
          opaque, it is what separates the header column from the timeline. */}
      <div
        className={`flex min-w-0 flex-col justify-center gap-1 overflow-hidden ${
          coarse ? 'items-center' : 'px-1.5'
        } ${track.hidden ? 'opacity-40' : ''}`}
        style={{ height: trackHeightPx }}
      >
        {coarse ? (
          <>
            {trackHeightPx >= COARSE_MUTE_MIN_HEIGHT_PX && muteButton}
            {moreButton}
          </>
        ) : (
          <>
            {/* Identity line: which track this is, then how it behaves. */}
            <div className="flex items-center gap-1">
              {/* Adobe-style expand/collapse: chevron flips the track open to
                  reveal its per-property keyframe lanes below. */}
              <Tooltip label={t(expanded ? 'track.collapse' : 'track.expand')}>
                <button
                  className={btn}
                  aria-label={t('track.expand')}
                  aria-pressed={expanded}
                  onClick={() => toggleTrackExpanded(track.id)}
                >
                  {expanded ? (
                    <ChevronDownIcon className="h-3.5 w-3.5 text-blue-300" />
                  ) : (
                    <ChevronRightIcon className="h-3.5 w-3.5" />
                  )}
                </button>
              </Tooltip>
              {/* "V1" / "A2", the name every NLE gives a lane. The header used
                  to carry no identity at all, so two audio tracks were the same
                  row of glyphs twice over. */}
              <span
                className="min-w-0 flex-1 truncate text-3xs font-medium tracking-wide text-zinc-400"
                title={t(video ? 'a11y.track.video' : 'a11y.track.audio', { n: ordinal })}
              >
                {t(video ? 'track.label.video' : 'track.label.audio', { n: ordinal })}
              </span>
              <div className="flex flex-none items-center gap-0.5">
                {muteButton}
                {video && (
                  <Tooltip label={t(track.hidden ? 'track.show' : 'track.hide')}>
                    <button
                      className={track.hidden ? btnOn : btn}
                      aria-label={t('track.hide')}
                      aria-pressed={!!track.hidden}
                      onClick={() => toggleTrackHidden(track.id)}
                    >
                      {track.hidden ? (
                        <EyeClosedIcon className="h-3.5 w-3.5 text-red-400" />
                      ) : (
                        <EyeOpenIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </Tooltip>
                )}
                <Tooltip label={t(track.locked ? 'track.unlock' : 'track.lock')}>
                  <button
                    className={track.locked ? btnOn : btn}
                    aria-label={t('track.lock')}
                    aria-pressed={!!track.locked}
                    onClick={() => toggleTrackLocked(track.id)}
                  >
                    {track.locked ? (
                      <LockClosedIcon className="h-3.5 w-3.5 text-amber-400" />
                    ) : (
                      <LockOpen1Icon className="h-3.5 w-3.5" />
                    )}
                  </button>
                </Tooltip>
              </div>
              {/* Hairline before the overflow: it opens things, the three
                  buttons beside it toggle things. */}
              <span aria-hidden="true" className="h-3.5 w-px flex-none bg-zinc-700/70" />
              {moreButton}
            </div>

            {showVolume && (
              <div className="relative flex items-center gap-1.5">
                <SpeakerLoudIcon className={faderIcon} aria-hidden="true" />
                <input
                  ref={volumeRef}
                  type="range"
                  min={0}
                  max={1}
                  step={DB_STEP_FADER}
                  value={gainToFader(track.volume ?? 1)}
                  className={slider}
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
            )}
            {showOpacity && (
              <div className="flex items-center gap-1.5">
                <BlendingModeIcon className={faderIcon} aria-hidden="true" />
                <input
                  ref={opacityRef}
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={track.opacity ?? 1}
                  className={slider}
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
              </div>
            )}
            {showMeter && (
              // Indented onto the faders' column by an empty icon slot, so the
              // level reads as belonging to the volume line above it.
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-3 w-3 flex-none" />
                <TrackMeter trackId={track.id} />
              </div>
            )}
            {badgeAt &&
              createPortal(
                <div
                  className="pointer-events-none fixed z-[200] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-zinc-950/85 px-1 py-0.5 text-3xs tabular-nums leading-tight text-zinc-100 shadow"
                  style={{ left: badgeAt.left, top: badgeAt.top }}
                >
                  {badgeAt.kind === 'volume'
                    ? gainDb(track.volume ?? 1)
                    : `${Math.round((track.opacity ?? 1) * 100)}%`}
                </div>,
                document.body,
              )}
          </>
        )}
      </div>
      {expanded && (
        <div
          className="flex flex-col"
          style={{
            height: lanesHeightPx(lanes.length),
            paddingTop: KEYFRAME_LANES_GAP_PX,
          }}
        >
          {lanes.map((prop) => (
            <div
              key={prop}
              className="flex items-center gap-1 border-t border-zinc-800/50 bg-zinc-900/40 px-1.5 text-4xs uppercase tracking-wide text-zinc-500"
              style={{ height: KEYFRAME_LANE_HEIGHT_PX }}
            >
              <ComponentInstanceIcon className="h-2 w-2 text-zinc-500" />
              <span className="truncate">{t(propHeaderKey(prop))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Inspector i18n key for the property label shown in an expanded track header. */
function propHeaderKey(prop: KeyframeProp): ParseKeys {
  switch (prop) {
    case 'x':
      return 'inspector.positionX';
    case 'y':
      return 'inspector.positionY';
    case 'scale':
      return 'inspector.scale';
    case 'rotation':
      return 'inspector.rotation';
    case 'opacity':
      return 'inspector.opacity';
    // Same labels the inspector's Adjust sliders carry.
    default:
      return `inspector.adjust.${prop}` as ParseKeys;
  }
}
