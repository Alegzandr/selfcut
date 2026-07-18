import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Repeat, SkipBack } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { Tooltip } from './Tooltip';
import { formatClock, formatClockParts } from '../lib/time';

/**
 * Timecode updated 60×/sec during playback - written straight to the DOM from
 * a store subscription instead of re-rendering through React every frame.
 */
function TimeReadout() {
  const { t } = useTranslation();
  const currentRef = useRef<HTMLSpanElement>(null);
  const framesRef = useRef<HTMLSpanElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const apply = () => {
      const s = useStore.getState();
      const cur = formatClockParts(s.currentTimeMs, s.project.fps, s.timeFormat);
      const total = formatClockParts(projectDurationMs(s.project), s.project.fps, s.timeFormat);
      if (currentRef.current) currentRef.current.textContent = cur.main;
      if (framesRef.current) framesRef.current.textContent = cur.frames ? `.${cur.frames}` : '';
      if (totalRef.current) totalRef.current.textContent = total.main;
    };
    apply();
    return useStore.subscribe((s, prev) => {
      if (
        s.currentTimeMs !== prev.currentTimeMs ||
        s.project !== prev.project ||
        s.timeFormat !== prev.timeFormat
      )
        apply();
    });
  }, []);

  return (
    <Tooltip label={t('transport.timecode')}>
      <span className="min-w-[118px] text-center font-mono text-xs tabular-nums text-zinc-400">
        <span ref={currentRef} className="text-zinc-100" />
        <span ref={framesRef} className="text-[10px] text-zinc-400" /> / <span ref={totalRef} />
      </span>
    </Tooltip>
  );
}

/**
 * The transport is a pure *playback* control (back-to-start, play/pause,
 * timecode, loop). Editing and view tools (split, delete, snap, zoom, markers)
 * live in the top bar so this bar stays focused on driving playback.
 */
export function Transport() {
  const { t } = useTranslation();
  const playing = useStore((s) => s.playing);
  const playbackRate = useStore((s) => s.playbackRate);
  const region = useStore((s) => s.loopRegion);
  const loopEnabled = useStore((s) => s.loopEnabled);
  const timeFormat = useStore((s) => s.timeFormat);
  const fps = useStore((s) => s.project.fps);
  const { setPlaying, seek, toggleLoopEnabled, setLoopRegion } = useStore.getState();

  return (
    <div className="flex h-11 flex-none items-center justify-center gap-1 border-y border-zinc-800 bg-zinc-900 px-2">
      <Tooltip label={t('transport.backToStart')}>
        <button
          className="touch-hit rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
          onClick={() => seek(0)}
        >
          <SkipBack className="h-4 w-4" />
        </button>
      </Tooltip>
      <Tooltip label={playing ? t('transport.pause') : t('transport.play')}>
      <button
        className="touch-hit relative rounded-full bg-zinc-300 p-2.5 text-zinc-950 active:bg-zinc-200"
        onClick={() => setPlaying(!playing)}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
        {/* Shuttle badge: visible while J/L drive playback at a non-1× rate. */}
        {playing && playbackRate !== 1 && (
          <span className="absolute -right-1.5 -top-1.5 rounded-full bg-sky-500 px-1 text-[9px] font-bold leading-4 text-white">
            {playbackRate < 1 ? playbackRate.toFixed(2).replace(/0$/, '') : playbackRate}×
          </span>
        )}
      </button>
      </Tooltip>
      <TimeReadout />

      <div className="mx-1 h-5 w-px bg-zinc-800" />

      <Tooltip label={t('transport.loop')}>
        <button
          className={`touch-hit rounded-lg p-2 ${loopEnabled ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-400'} active:bg-zinc-800`}
          onClick={toggleLoopEnabled}
        >
          <Repeat className="h-4 w-4" />
        </button>
      </Tooltip>

      {/* Selection readout: clicking it clears the region (like clicking the empty bar). */}
      {region && (
        <Tooltip label={t('transport.region.clear')}>
          <button
            className="touch-hit rounded-lg px-2 py-1 font-mono text-[11px] tabular-nums text-amber-300 active:bg-zinc-800"
            onClick={() => setLoopRegion(null)}
          >
            {formatClock(region.startMs, fps, timeFormat)} →{' '}
            {formatClock(region.endMs, fps, timeFormat)}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
