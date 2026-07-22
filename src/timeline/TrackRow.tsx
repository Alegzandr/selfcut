import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Track } from '../types';
import { trackCrossfades } from '../model';
import { ClipView } from './ClipView';
import { useStore } from '../store/store';
import { TrackKeyframeLanes } from './TrackKeyframeLanes';
import { trackRowHeightPx } from './trackHeight';

interface Props {
  track: Track;
  /** Position in the track list (0-based), for the accessible name. */
  index: number;
  pxPerMs: number;
}

/**
 * The clip lane for one track. Its controls live in {@link TrackHeader}, in the
 * fixed pane to the left, so this row is pure timeline: background + clips.
 */
export const TrackRow = memo(function TrackRow({ track, index, pxPerMs }: Props) {
  const { t } = useTranslation();
  const xfades = trackCrossfades(track.clips);
  const baseHeightPx = useStore((s) => s.trackHeightPx);
  const expanded = useStore((s) => s.expandedTrackIds.includes(track.id));
  const rowHeight = trackRowHeightPx(track, baseHeightPx, expanded);

  // "Video track 2, muted, locked" - the row's name plus its toggled states,
  // so a screen reader hears why the clips inside refuse to change.
  const rowLabel = [
    t(track.kind === 'video' ? 'a11y.track.video' : 'a11y.track.audio', { n: index + 1 }),
    track.muted ? t('a11y.track.state.muted') : null,
    track.hidden ? t('a11y.track.state.hidden') : null,
    track.locked ? t('a11y.track.state.locked') : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      role="listitem"
      aria-label={rowLabel}
      className={`relative border-b border-zinc-800/80 ${track.hidden ? 'opacity-40' : ''}`}
      style={{ height: rowHeight }}
      data-rowbg
      data-track-id={track.id}
    >
      {/* A locked lane reads as frozen and swallows every pointer gesture on its
          clips, so a drag that starts here cannot move, trim or fade anything.
          The row background stays live underneath, so scrubbing still works. */}
      {track.locked && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgb(250_204_21/0.06)_6px,rgb(250_204_21/0.06)_12px)]"
        />
      )}
      {/* Clip lane sits at the top; when the track is expanded, the keyframe
          lanes take the rest, so the clip band stays the same size the user
          set with the vertical-zoom slider. */}
      {/* data-clip-lane: this wrapper covers the whole clip band, so every press
          on empty space in the band lands here rather than on the row
          background. Without the marker the timeline reads those presses as
          "not a background surface" and a collapsed track loses click-to-seek,
          marquee select and its context menu entirely. It cannot simply carry
          `data-rowbg`: the clip drag resolves its rows container with
          `closest('[data-rowbg]').parentElement`, which this element would
          intercept. */}
      <div className="relative" data-clip-lane style={{ height: baseHeightPx }}>
        {/* `contents` when unlocked so the wrapper adds no box at all; when locked
            it turns into a plain static div, which swallows pointer events for
            its children without becoming their positioning ancestor. */}
        <div className={track.locked ? 'pointer-events-none' : 'contents'}>
          {track.clips.map((clip) => (
            <ClipView
              key={clip.id}
              clip={clip}
              trackKind={track.kind}
              trackNumber={index + 1}
              pxPerMs={pxPerMs}
              xfadeInMs={xfades.get(clip.id)?.inMs ?? 0}
              xfadeOutMs={xfades.get(clip.id)?.outMs ?? 0}
            />
          ))}
        </div>
      </div>
      {expanded && <TrackKeyframeLanes track={track} pxPerMs={pxPerMs} />}
    </div>
  );
});
