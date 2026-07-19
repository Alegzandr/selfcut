import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Repeat, SkipBack } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { Tooltip } from './Tooltip';
import { useEditorCommands } from './commands';
import { TrackHeightMenu } from './TrackHeightMenu';
import { PreviewZoomMenu } from '../preview/PreviewZoomMenu';
import { useIsCoarsePointer } from '../lib/device';
import { formatClock, formatClockParts, parseClock } from '../lib/time';

/**
 * Timecode updated 60×/sec during playback - written straight to the DOM from
 * a store subscription instead of re-rendering through React every frame.
 */
function TimeReadout() {
  const { t } = useTranslation();
  const currentRef = useRef<HTMLSpanElement>(null);
  const framesRef = useRef<HTMLSpanElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  /** Right-hand readout: total project duration, or time left until the end. */
  const [showRemaining, setShowRemaining] = useState(false);
  // The DOM writes below run outside React, so the subscription reads the mode
  // from a ref rather than closing over a stale state value.
  const remainingRef = useRef(showRemaining);
  remainingRef.current = showRemaining;
  /** Click-to-type on the current time: a draft string until it parses. */
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (draft !== null) return;
    const apply = () => {
      const s = useStore.getState();
      const durationMs = projectDurationMs(s.project);
      const cur = formatClockParts(s.currentTimeMs, s.project.fps, s.timeFormat);
      const rightMs = remainingRef.current
        ? Math.max(0, durationMs - s.currentTimeMs)
        : durationMs;
      const right = formatClockParts(rightMs, s.project.fps, s.timeFormat);
      if (currentRef.current) currentRef.current.textContent = cur.main;
      if (framesRef.current) framesRef.current.textContent = cur.frames ? `.${cur.frames}` : '';
      if (totalRef.current)
        totalRef.current.textContent = remainingRef.current ? `-${right.main}` : right.main;
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
  }, [showRemaining, draft]);

  /**
   * Seed the field with the readout *exactly* as rendered - "0:05.00", dot and
   * all - so editing continues the number the user was looking at rather than
   * swapping in a different punctuation for the same instant.
   */
  const startEditing = () => {
    const s = useStore.getState();
    const { main, frames } = formatClockParts(s.currentTimeMs, s.project.fps, s.timeFormat);
    setDraft(frames ? `${main}.${frames}` : main);
    setInvalid(false);
  };

  const commit = () => {
    const s = useStore.getState();
    const ms = parseClock(draft ?? '', s.project.fps, s.timeFormat);
    // Unparseable input keeps the field open instead of jumping somewhere
    // arbitrary - the user gets to fix the typo.
    if (ms === null) {
      setInvalid(true);
      return;
    }
    s.seek(ms);
    setDraft(null);
  };

  return (
    <span className="min-w-[118px] text-center font-mono text-xs tabular-nums text-zinc-400">
      {draft !== null ? (
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          aria-label={t('transport.timecode.goto')}
          className={`w-[62px] rounded border bg-zinc-950 px-1 text-center font-mono text-xs tabular-nums text-zinc-100 outline-none ${
            invalid ? 'border-red-500' : 'border-sky-500'
          }`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          // Hotkeys ignore inputs, but stop the bubble so nothing else claims Enter/Escape.
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
            e.stopPropagation();
          }}
          onBlur={() => setDraft(null)}
        />
      ) : (
        <Tooltip label={t('transport.timecode.goto')}>
          <button className="rounded px-0.5 active:bg-zinc-800" onClick={startEditing}>
            <span ref={currentRef} className="text-zinc-100" />
            <span ref={framesRef} className="text-[10px] text-zinc-400" />
          </button>
        </Tooltip>
      )}{' '}
      /{' '}
      <Tooltip label={showRemaining ? t('transport.remaining') : t('transport.total')}>
        <button
          className="rounded px-0.5 active:bg-zinc-800"
          onClick={() => setShowRemaining((v) => !v)}
        >
          <span ref={totalRef} />
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * Snapping and timeline zoom, pinned to the right end of the transport - the
 * bar that sits directly on top of the timeline they steer. They are *view*
 * controls, not editing tools: split, delete, insert and the rest stay in the
 * top bar so this row never becomes a second toolbar.
 *
 * Desktop only: touch zooms by pinching and has these in the tool rail.
 */
function ViewToolButton({ id }: { id: string }) {
  const { t } = useTranslation();
  const command = useEditorCommands()[id];
  const Icon = command?.icon;
  if (!command || !Icon) return null;
  return (
    <Tooltip
      label={command.hintKey ? t(command.hintKey) : t(command.labelKey)}
      // Snapping states its own key inside the hint, so the chip would repeat it.
      shortcut={id === 'view.snap' ? undefined : command.shortcut}
    >
      <button
        className={`touch-hit rounded-lg p-2 active:bg-zinc-800 ${
          command.checked ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400'
        }`}
        aria-pressed={command.checked}
        onClick={command.onClick}
      >
        <Icon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

/**
 * Timeline view controls, at the left end of the transport - the same end of the
 * bar as the track headers they size, and directly over the timeline they steer.
 *
 * Zoom is the two steppers and nothing else. Ctrl+wheel already covers "a bit
 * more", and fitting a *window* to its content is something the monitor does -
 * the timeline scrolls, so there is no window to fit it to.
 */
function TimelineViewTools() {
  return (
    <div className="flex items-center gap-0.5">
      <ViewToolButton id="view.snap" />
      <TrackHeightMenu />
      <div className="mx-1 h-5 w-px bg-zinc-800" />
      <ViewToolButton id="view.zoomOut" />
      <ViewToolButton id="view.zoomIn" />
    </div>
  );
}

/**
 * The transport is a pure *playback* control (back-to-start, play/pause,
 * timecode, loop), centred in the bar. Its right end carries the timeline's
 * view controls, which belong next to the timeline rather than in the top bar.
 */
export function Transport() {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const playing = useStore((s) => s.playing);
  const playbackRate = useStore((s) => s.playbackRate);
  const region = useStore((s) => s.loopRegion);
  const loopEnabled = useStore((s) => s.loopEnabled);
  const timeFormat = useStore((s) => s.timeFormat);
  const fps = useStore((s) => s.project.fps);
  const { setPlaying, seek, toggleLoopEnabled, setLoopRegion } = useStore.getState();

  return (
    <div className="flex h-11 flex-none items-center justify-center border-y border-zinc-800 bg-zinc-900 px-2">
      {/* The two flanks split what is left over evenly, so the playback cluster
          stays optically centred whichever side happens to be wider. */}
      {!coarse && (
        <div className="flex min-w-0 flex-1 justify-start">
          <TimelineViewTools />
        </div>
      )}
      <div className="flex flex-none items-center gap-1">
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

      {/* The monitor's own scale, on the monitor's side of the bar. */}
      {!coarse && (
        <div className="flex min-w-0 flex-1 justify-end">
          <PreviewZoomMenu />
        </div>
      )}
    </div>
  );
}
