import { memo } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Film, Music2, Trash2, Volume2, VolumeX } from 'lucide-react';
import { Track } from '../types';
import { useStore } from '../store/store';
import { ClipView } from './ClipView';
import { TRACK_HEIGHT_PX } from '../app/config';

interface Props {
  track: Track;
  pxPerMs: number;
}

export const TrackRow = memo(function TrackRow({ track, pxPerMs }: Props) {
  const selectedClipId = useStore((s) => s.selectedClipId);
  const { toggleTrackMuted, toggleTrackHidden, moveTrack, removeTrack } = useStore.getState();

  const btn = 'flex h-4.5 w-4.5 items-center justify-center rounded text-zinc-500 active:bg-zinc-700';

  return (
    <div
      className={`relative border-b border-zinc-800/80 ${track.hidden ? 'opacity-40' : ''}`}
      style={{ height: TRACK_HEIGHT_PX }}
      data-rowbg
    >
      {/* Sticky track header */}
      <div className="sticky left-0 z-10 flex h-full w-11 flex-col items-center justify-center gap-0.5 border-r border-zinc-800 bg-zinc-900 py-0.5">
        <div className="flex items-center gap-0.5">
          {track.kind === 'video' ? (
            <Film className="h-3 w-3 text-sky-400" />
          ) : (
            <Music2 className="h-3 w-3 text-emerald-400" />
          )}
          <button className={btn} onClick={() => removeTrack(track.id)} title="Delete track">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <button className={btn} onClick={() => toggleTrackMuted(track.id)} title="Mute track">
            {track.muted ? (
              <VolumeX className="h-3 w-3 text-red-400" />
            ) : (
              <Volume2 className="h-3 w-3" />
            )}
          </button>
          {track.kind === 'video' ? (
            <button className={btn} onClick={() => toggleTrackHidden(track.id)} title="Hide track">
              {track.hidden ? <EyeOff className="h-3 w-3 text-red-400" /> : <Eye className="h-3 w-3" />}
            </button>
          ) : (
            <span className="h-4.5 w-4.5" />
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button className={btn} onClick={() => moveTrack(track.id, -1)} title="Move track up">
            <ChevronUp className="h-3 w-3" />
          </button>
          <button className={btn} onClick={() => moveTrack(track.id, 1)} title="Move track down">
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>

      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          trackKind={track.kind}
          selected={clip.id === selectedClipId}
          pxPerMs={pxPerMs}
        />
      ))}
    </div>
  );
});
