import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { TrackRow } from './TrackRow';
import { Ruler } from './Ruler';
import { Playhead } from './Playhead';
import { MarkerBar, TimelineOverlay } from './MarkerBar';
import { msFromClientX, msFromContentX, timelineContentEl } from './coords';
import { TIMELINE_PAD_LEFT, TRACK_HEIGHT_PX } from '../app/config';
import { clipEndMs } from '../store/store';
import { clamp } from '../lib/time';
import { useImport } from '../ui/useImport';
import { useIsCoarsePointer } from '../lib/device';
import { useTimelineWheel } from './hooks/useTimelineWheel';
import { usePinchZoom } from './hooks/usePinchZoom';
import { useMobileScrubSync } from './hooks/useMobileScrubSync';
import { useAssetDrop } from './hooks/useAssetDrop';

/** Vertical guide at the point a drag is currently snapped to (all NLEs flash one). */
function SnapGuide() {
  const snapGuideMs = useStore((s) => s.snapGuideMs);
  const padLeft = useStore((s) => s.timelinePadLeft);
  const pxPerSec = useStore((s) => s.pxPerSec);
  if (snapGuideMs === null) return null;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-sky-300/90"
      style={{ left: padLeft + snapGuideMs * (pxPerSec / 1000) }}
    />
  );
}

export function Timeline() {
  const { t } = useTranslation();
  const project = useStore((s) => s.project);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const importing = useStore((s) => s.importing);
  const coarse = useIsCoarsePointer();
  const importFiles = useImport();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [halfW, setHalfW] = useState(0);
  const programmaticScroll = useRef(false);
  const pinching = useRef(false);
  const lastScrollLeft = useRef(0);
  // Marquee (rubber-band) selection: press anchor + base selection in a ref
  // (stable across renders), the live box in state (drawn as a fixed overlay).
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const marqueeRef = useRef<{
    x0: number;
    y0: number;
    base: string[];
    el: HTMLElement;
    pointerId: number;
  } | null>(null);
  const marqueeActive = marquee !== null;

  // Escape aborts an in-flight marquee: box gone, selection back to the base.
  useEffect(() => {
    if (!marqueeActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      const mq = marqueeRef.current;
      if (mq) {
        useStore.getState().setSelectedClips(mq.base);
        try {
          mq.el.releasePointerCapture(mq.pointerId);
        } catch {
          // already released
        }
      }
      marqueeRef.current = null;
      setMarquee(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [marqueeActive]);

  const empty = project.tracks.length === 0;
  const pxPerMs = pxPerSec / 1000;
  const durationMs = projectDurationMs(project);
  // Mobile: half the viewport on both sides so t=0 and the end can sit under the
  // fixed center playhead. Desktop: fixed pad + room to drag clips past the end.
  const padLeft = coarse ? halfW : TIMELINE_PAD_LEFT;
  const contentWidth = coarse
    ? padLeft + durationMs * pxPerMs + halfW
    : TIMELINE_PAD_LEFT + (durationMs + 60_000) * pxPerMs;

  // Measure the viewport half-width (mobile centered playhead).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setHalfW(scroller.clientWidth / 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [coarse, empty]);

  // Publish the pad so Ruler/ClipView/Playhead convert px<->ms consistently.
  useEffect(() => {
    useStore.getState().setTimelinePadLeft(padLeft);
  }, [padLeft]);

  useTimelineWheel(scrollerRef, coarse, empty);
  usePinchZoom(scrollerRef, coarse, pinching, empty);
  useMobileScrubSync(scrollerRef, coarse, { programmaticScroll, pinching, lastScrollLeft }, empty);
  const { onAssetDragOver, onAssetDrop } = useAssetDrop();

  if (empty) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        onDragOver={onAssetDragOver}
        onDrop={onAssetDrop}
      >
        <p className="text-sm text-zinc-500">
          {importing ? t('timeline.importing') : t('timeline.dropzone.title')}
        </p>
        <label className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 active:bg-zinc-700">
          {t('timeline.dropzone.choose')}
          <input
            type="file"
            accept="video/*,audio/*,.srt,.vtt"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void importFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {!coarse && !importing && (
          <p className="text-xs text-zinc-400">
            {/* One sentence, one key: the <kbd> keycaps are markup inside the translation,
                so translators keep control of the word order around them. */}
            <Trans
              i18nKey="timeline.hint"
              components={{ kbd: <kbd className="font-mono text-zinc-500" /> }}
            />
          </p>
        )}
      </div>
    );
  }

  const { addTrack, selectClip } = useStore.getState();

  // Desktop: click on empty track background moves the playhead there (and scrubs while held).
  const seekToClientX = (e: React.PointerEvent) => {
    useStore.getState().seek(msFromClientX(e.currentTarget as HTMLElement, e.clientX));
  };

  /** Live marquee: select every clip the box touches (rows × time span). */
  const updateMarquee = (rowsEl: HTMLElement, clientX: number, clientY: number) => {
    const mq = marqueeRef.current;
    if (!mq) return;
    setMarquee({ x0: mq.x0, y0: mq.y0, x1: clientX, y1: clientY });
    const s = useStore.getState();
    const content = timelineContentEl(rowsEl);
    if (!content) return;
    const [minY, maxY] = [Math.min(mq.y0, clientY), Math.max(mq.y0, clientY)];
    const ids = new Set(mq.base);
    const top = rowsEl.getBoundingClientRect().top;
    const n = s.project.tracks.length;
    if (maxY >= top && minY <= top + n * TRACK_HEIGHT_PX) {
      const r0 = clamp(Math.floor((minY - top) / TRACK_HEIGHT_PX), 0, n - 1);
      const r1 = clamp(Math.floor((maxY - top) / TRACK_HEIGHT_PX), 0, n - 1);
      const t0 = msFromContentX(content, Math.min(mq.x0, clientX));
      const t1 = msFromContentX(content, Math.max(mq.x0, clientX));
      for (const track of s.project.tracks.slice(r0, r1 + 1)) {
        for (const clip of track.clips) {
          if (clip.timelineStartMs < t1 && clipEndMs(clip) > t0) ids.add(clip.id);
        }
      }
    }
    s.setSelectedClips([...ids]);
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.rowbg === undefined) return;
    // Ctrl/Cmd+drag on the background (desktop): marquee / rubber-band select.
    // Shift on top keeps the existing selection and adds the boxed clips to it.
    if (!coarse && e.button === 0 && (e.ctrlKey || e.metaKey)) {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      marqueeRef.current = {
        x0: e.clientX,
        y0: e.clientY,
        base: e.shiftKey ? useStore.getState().selectedClipIds : [],
        el,
        pointerId: e.pointerId,
      };
      return;
    }
    selectClip(null);
    if (coarse || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekToClientX(e);
  };
  const onBgPointerMove = (e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    if (marqueeRef.current) updateMarquee(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    else seekToClientX(e);
  };
  const onBgPointerUp = (e: React.PointerEvent) => {
    const mq = marqueeRef.current;
    if (!mq) return;
    // A Ctrl+click that never moved: no box - just apply the base selection
    // (clears everything, or keeps it as-is when Shift was adding).
    if (Math.abs(e.clientX - mq.x0) < 4 && Math.abs(e.clientY - mq.y0) < 4) {
      useStore.getState().setSelectedClips(mq.base);
    }
    marqueeRef.current = null;
    setMarquee(null);
  };

  return (
    <div className="relative min-h-0 flex-1" onDragOver={onAssetDragOver} onDrop={onAssetDrop}>
      <div
        ref={scrollerRef}
        className="timeline-scroller h-full overflow-auto overscroll-none bg-zinc-950"
      >
        <div
          data-timeline-content
          className="relative min-h-full"
          style={{ width: contentWidth, minWidth: '100%' }}
          onPointerDown={(e) => {
            // Empty space below the tracks: pressing it drops the selection,
            // like every NLE (rows handle their own background separately).
            if (e.target === e.currentTarget) selectClip(null);
          }}
        >
          <MarkerBar pxPerMs={pxPerMs} />
          <Ruler durationMs={durationMs} pxPerMs={pxPerMs} overscanMs={coarse ? 0 : 30_000} />
          <div
            onPointerDown={onBgPointerDown}
            onPointerMove={onBgPointerMove}
            onPointerUp={onBgPointerUp}
            onPointerCancel={onBgPointerUp}
            onContextMenu={(e) => {
              // Only the empty track background: clips / headers open their own menus.
              if (coarse || (e.target as HTMLElement).dataset.rowbg === undefined) return;
              e.preventDefault();
              useStore.getState().openContextMenu(e.clientX, e.clientY, { kind: 'timeline' });
            }}
          >
            {project.tracks.map((track) => (
              <TrackRow key={track.id} track={track} pxPerMs={pxPerMs} />
            ))}
          </div>
          {/* Region shading + marker lines: after the tracks, so they paint over the clips. */}
          <TimelineOverlay pxPerMs={pxPerMs} trackCount={project.tracks.length} />
          <SnapGuide />

          <div className="sticky left-0 flex w-fit gap-2 p-2">
            <button
              className="touch-hit rounded-md border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800 pointer-coarse:py-2"
              onClick={() => addTrack('video')}
            >
              <Plus className="mr-1 inline h-3 w-3" />
              {t('timeline.addVideoTrack')}
            </button>
            <button
              className="touch-hit rounded-md border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800 pointer-coarse:py-2"
              onClick={() => addTrack('audio')}
            >
              <Plus className="mr-1 inline h-3 w-3" />
              {t('timeline.addAudioTrack')}
            </button>
          </div>

          {!coarse && <Playhead scrollerRef={scrollerRef} />}
        </div>
      </div>

      {/* Marquee box: viewport-fixed so it stays put while the timeline scrolls. */}
      {marquee && (
        <div
          className="pointer-events-none fixed z-40 rounded-sm border border-sky-400/80 bg-sky-400/10"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {/* Mobile: fixed playhead at the center of the viewport (the timeline scrolls under it). */}
      {coarse && (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 z-30 w-0.5 -translate-x-1/2 bg-red-500">
          <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-red-500" />
        </div>
      )}
    </div>
  );
}
