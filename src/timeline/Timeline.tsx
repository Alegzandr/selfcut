import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { TrackRow } from './TrackRow';
import { Ruler } from './Ruler';
import { Playhead } from './Playhead';
import { MarkerBar, TimelineOverlay } from './MarkerBar';
import { TrackHeader } from './TrackHeader';
import { msFromContentX, timelineContentEl } from './coords';
import { seekAtClientX } from './hooks/useScrub';
import {
  MARKER_BAR_HEIGHT_PX,
  RULER_HEIGHT_PX,
  TIMELINE_PAD_LEFT,
  TRACK_HEADER_WIDTH_COARSE_PX,
  TRACK_HEADER_WIDTH_PX,
} from '../app/config';
import { ResizeHandle } from '../ui/ResizeHandle';
import { clipEndMs } from '../store/store';
import { clamp } from '../lib/time';
import { useImport } from '../ui/useImport';
import { useIsCoarsePointer } from '../lib/device';
import { useTimelineWheel } from './hooks/useTimelineWheel';
import { usePinchZoom } from './hooks/usePinchZoom';
import { useMobileScrubSync } from './hooks/useMobileScrubSync';
import { useAssetDrop } from './hooks/useAssetDrop';
import { publishViewport } from './viewport';
import { trackIndexAtY, trackTops } from './trackHeight';
import { keyframeKey, keyframesInBox } from './keyframeSelection';
import type { KeyframeRef } from '../types';

/** Vertical guide at the point a drag is currently snapped to (all NLEs flash one). */
function SnapGuide() {
  const snapGuideMs = useStore((s) => s.snapGuideMs);
  const padLeft = useStore((s) => s.timelinePadLeft);
  const pxPerSec = useStore((s) => s.pxPerSec);
  if (snapGuideMs === null) return null;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-10 w-px bg-sky-300/90"
      style={{ left: padLeft + snapGuideMs * (pxPerSec / 1000) }}
    />
  );
}

export function Timeline() {
  const { t } = useTranslation();
  const project = useStore((s) => s.project);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const trackHeightPx = useStore((s) => s.trackHeightPx);
  const trackHeaderWidthPx = useStore((s) => s.trackHeaderWidthPx);
  const importing = useStore((s) => s.importing);
  const coarse = useIsCoarsePointer();
  const importFiles = useImport();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const [halfW, setHalfW] = useState(0);
  // Height the scroller's horizontal scrollbar steals, so the header pane stops
  // at the same line as the last visible row instead of running under it.
  const [hBarPx, setHBarPx] = useState(0);
  const programmaticScroll = useRef(false);
  const pinching = useRef(false);
  const lastScrollLeft = useRef(0);
  // Marquee (rubber-band) selection: press anchor + base selection in a ref
  // (stable across renders), the live box in state (drawn as a fixed overlay).
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const marqueeRef = useRef<{
    x0: number;
    y0: number;
    base: string[];
    baseKeyframes: KeyframeRef[];
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
        useStore.getState().setSelectedKeyframes(mq.baseKeyframes);
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
  const headerWidth = coarse ? TRACK_HEADER_WIDTH_COARSE_PX : trackHeaderWidthPx;
  const contentWidth = coarse
    ? padLeft + durationMs * pxPerMs + halfW
    : TIMELINE_PAD_LEFT + (durationMs + 60_000) * pxPerMs;

  // Mirror the scroller's vertical offset onto the header pane. Done on the raw
  // scroll event rather than the rAF-throttled publish below: a frame of lag
  // here shows up as the headers visibly sliding against their own rows.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const sync = () => {
      const el = headersRef.current;
      if (el) el.style.transform = `translateY(${-scroller.scrollTop}px)`;
    };
    sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    return () => scroller.removeEventListener('scroll', sync);
  }, [empty]);

  // Measure the viewport half-width (mobile centered playhead) and the
  // horizontal scrollbar the header pane has to stop short of.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      setHalfW(scroller.clientWidth / 2);
      setHBarPx(scroller.offsetHeight - scroller.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [coarse, empty]);

  // Publish the pad so Ruler/ClipView/Playhead convert px<->ms consistently.
  useEffect(() => {
    useStore.getState().setTimelinePadLeft(padLeft);
  }, [padLeft]);

  // Publish the visible content range for virtualization (ruler ticks, clip
  // filmstrips, waveforms). Scrolling is rAF-throttled; a ResizeObserver covers
  // panel resizes. Zoom changes content coords without always firing a scroll,
  // so a render-driven publish below refreshes it after every re-render too.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    const publish = () => {
      raf = 0;
      publishViewport({
        left: scroller.scrollLeft,
        right: scroller.scrollLeft + scroller.clientWidth,
      });
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(publish);
    };
    publish();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(publish);
    ro.observe(scroller);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [empty]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) {
      publishViewport({
        left: scroller.scrollLeft,
        right: scroller.scrollLeft + scroller.clientWidth,
      });
    }
  });

  useTimelineWheel(scrollerRef, coarse, empty);
  usePinchZoom(scrollerRef, coarse, pinching, empty);
  useMobileScrubSync(scrollerRef, coarse, { programmaticScroll, pinching, lastScrollLeft }, empty);
  const { onAssetDragOver, onAssetDragLeave, onAssetDrop, newTrackDragOver } = useAssetDrop();

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
        <label className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700/60 active:bg-zinc-700">
          {t('timeline.dropzone.choose')}
          <input
            type="file"
            accept="video/*,audio/*,.srt,.vtt"
            multiple
            className="hidden"
            onChange={(e) => {
              // The empty-project dropzone builds a first cut: these files go
              // onto the timeline, unlike an import from the media library.
              if (e.target.files?.length)
                void importFiles(e.target.files, { placeOnTimeline: true });
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

  // Desktop: click on empty track background moves the playhead there. It goes
  // through the scrub's own rule, so a click here and a click on the ruler mean
  // exactly the same thing - same magnetism, same frame, same stopped transport.
  const seekToClientX = (e: React.PointerEvent) => {
    seekAtClientX(e.currentTarget as HTMLElement, e.clientX, e.shiftKey);
  };

  /**
   * Live marquee: select every clip the box touches (rows × time span), plus
   * every keyframe diamond it encloses on the property lanes of the expanded
   * tracks it crosses. One box does both - which of the two the user meant is
   * answered by where they dragged, not by a modifier.
   */
  const updateMarquee = (rowsEl: HTMLElement, clientX: number, clientY: number) => {
    const mq = marqueeRef.current;
    if (!mq) return;
    setMarquee({ x0: mq.x0, y0: mq.y0, x1: clientX, y1: clientY });
    const s = useStore.getState();
    const content = timelineContentEl(rowsEl);
    if (!content) return;
    const [minY, maxY] = [Math.min(mq.y0, clientY), Math.max(mq.y0, clientY)];
    const ids = new Set(mq.base);
    const keyframes = [...mq.baseKeyframes];
    const seenKeys = new Set(keyframes.map(keyframeKey));
    const top = rowsEl.getBoundingClientRect().top;
    const n = s.project.tracks.length;
    // Variable row heights: sum the tops once, then walk to find the two rows
    // the marquee touches instead of dividing by a fixed height.
    const expanded = new Set(s.expandedTrackIds);
    const tops = trackTops(s.project.tracks, s.trackHeightPx, expanded);
    const totalH = tops[n]!;
    if (maxY >= top && minY <= top + totalH) {
      const r0 = clamp(trackIndexAtY(tops, minY - top), 0, n - 1);
      const r1 = clamp(trackIndexAtY(tops, maxY - top), 0, n - 1);
      const t0 = msFromContentX(content, Math.min(mq.x0, clientX));
      const t1 = msFromContentX(content, Math.max(mq.x0, clientX));
      for (const track of s.project.tracks.slice(r0, r1 + 1)) {
        for (const clip of track.clips) {
          if (clip.timelineStartMs < t1 && clipEndMs(clip) > t0) ids.add(clip.id);
        }
      }
      for (const ref of keyframesInBox(s.project.tracks, expanded, tops, {
        minY: minY - top,
        maxY: maxY - top,
        t0,
        t1,
      })) {
        const key = keyframeKey(ref);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        keyframes.push(ref);
      }
    }
    // A pointermove that didn't change the boxed set must not commit a fresh
    // selection array: that would re-render every touched clip on every move.
    const cur = s.selectedClipIds;
    if (cur.length !== ids.size || !cur.every((id) => ids.has(id))) {
      s.setSelectedClips([...ids]);
    }
    const curKeys = s.selectedKeyframes;
    if (curKeys.length !== keyframes.length || !curKeys.every((k) => seenKeys.has(keyframeKey(k)))) {
      s.setSelectedKeyframes(keyframes);
    }
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // The row background and the empty part of a keyframe lane are both fair
    // game to start a box on - a lane is where the keyframes are, so refusing
    // it would put the diamonds out of reach of the very gesture that selects
    // them. A diamond itself stops the event before it ever gets here.
    const onBackground =
      target.dataset.rowbg !== undefined ||
      target.dataset.clipLane !== undefined ||
      target.dataset.trackLane !== undefined;
    if (!onBackground) return;
    // Left-drag on the background (desktop): marquee / rubber-band select, the
    // reflex every NLE trained. Shift keeps the existing selection and adds to
    // it. Scrubbing lives on the ruler, which is why the background is free.
    if (!coarse && e.button === 0) {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      const s = useStore.getState();
      marqueeRef.current = {
        x0: e.clientX,
        y0: e.clientY,
        base: e.shiftKey ? s.selectedClipIds : [],
        baseKeyframes: e.shiftKey ? s.selectedKeyframes : [],
        el,
        pointerId: e.pointerId,
      };
      return;
    }
    selectClip(null);
  };
  const onBgPointerMove = (e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    if (marqueeRef.current) updateMarquee(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };
  const onBgPointerUp = (e: React.PointerEvent) => {
    const mq = marqueeRef.current;
    if (!mq) return;
    marqueeRef.current = null;
    setMarquee(null);
    // A press that never moved is a click, not a box: drop the selection and
    // put the playhead there, the behaviour the background had before.
    if (Math.abs(e.clientX - mq.x0) < 4 && Math.abs(e.clientY - mq.y0) < 4) {
      useStore.getState().setSelectedClips(mq.base);
      useStore.getState().setSelectedKeyframes(mq.baseKeyframes);
      if (!mq.base.length && !mq.baseKeyframes.length) {
        selectClip(null);
        seekToClientX(e);
      }
    }
  };

  return (
    <div
      className="relative flex min-h-0 flex-1"
      onDragOver={onAssetDragOver}
      onDragLeave={onAssetDragLeave}
      onDrop={onAssetDrop}
    >
      {/* Fixed header pane, outside the scroller: the timeline cannot reach it. */}
      <div
        className="flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-900"
        style={{ width: headerWidth, paddingBottom: hBarPx }}
      >
        {/* Corner block, matching the marker bar + ruler so row N of the pane
            lines up with row N of the scroller. */}
        <div
          className="shrink-0 border-b border-zinc-800"
          style={{ height: MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX }}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* Translated to mirror the scroller's vertical offset - the pane has
              no scroll of its own, so the two can never drift apart. */}
          <div ref={headersRef} className="will-change-transform">
            {project.tracks.map((track) => (
              <TrackHeader key={track.id} track={track} />
            ))}
          </div>
        </div>
      </div>

      {/* Desktop only: the coarse pane is a fixed strip of icon buttons with
          nothing to widen, and there is no pointer to hit a 2px handle with. */}
      {!coarse && (
        <ResizeHandle
          width={trackHeaderWidthPx}
          onWidth={useStore.getState().setTrackHeaderWidthPx}
          defaultWidth={TRACK_HEADER_WIDTH_PX}
        />
      )}

      {/* min-w-0: without it the flex item sizes to the timeline content instead
          of clamping it, and the scroller never gets anything to scroll. */}
      <div className="relative min-h-0 min-w-0 flex-1">
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
              // One list item per track, each holding its clips as focusable
              // buttons: a screen reader walks the timeline track by track.
              role="list"
              aria-label={t('a11y.timeline.label')}
              onPointerDown={onBgPointerDown}
              onPointerMove={onBgPointerMove}
              onPointerUp={onBgPointerUp}
              onPointerCancel={onBgPointerUp}
              onContextMenu={(e) => {
                // Only the empty track background: clips / headers open their own menus.
                const bg = e.target as HTMLElement;
                if (coarse || (bg.dataset.rowbg === undefined && bg.dataset.clipLane === undefined))
                  return;
                e.preventDefault();
                useStore.getState().openContextMenu(e.clientX, e.clientY, { kind: 'timeline' });
              }}
            >
              {project.tracks.map((track, i) => (
                <TrackRow key={track.id} track={track} index={i} pxPerMs={pxPerMs} />
              ))}
            </div>
            {/* Placeholder row while an asset drag hovers below the last track:
                dropping there creates a fresh track instead of reusing one. */}
            {newTrackDragOver && (
              <div
                className="pointer-events-none flex items-center border-y border-dashed border-sky-400/60 bg-sky-400/10"
                style={{ height: trackHeightPx }}
              >
                <span className="sticky left-0 px-3 text-2xs font-medium text-sky-300">
                  {t('timeline.dropNewTrack')}
                </span>
              </div>
            )}
            {/* Region shading + marker lines: after the tracks, so they paint over the clips. */}
            <TimelineOverlay pxPerMs={pxPerMs} trackCount={project.tracks.length} />
            <SnapGuide />

            {/* Opaque + sticky at the scroller's left edge, so the buttons stay
              reachable however far the timeline is scrolled. */}
            <div className="sticky left-0 z-20 flex w-fit gap-2 bg-zinc-950 p-2">
              <button
                className="touch-hit rounded-md border border-dashed border-zinc-700 px-2 py-1 text-2xs text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 pointer-coarse:py-2"
                onClick={() => addTrack('video')}
              >
                <Plus className="mr-1 inline h-3 w-3" />
                {t('timeline.addVideoTrack')}
              </button>
              <button
                className="touch-hit rounded-md border border-dashed border-zinc-700 px-2 py-1 text-2xs text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 pointer-coarse:py-2"
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

        {/* Mobile: fixed playhead at the center of the scroller (the timeline scrolls under it). */}
        {coarse && (
          <div className="pointer-events-none absolute inset-y-0 left-1/2 z-30 w-0.5 -translate-x-1/2 bg-red-500">
            <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-red-500" />
          </div>
        )}
      </div>
    </div>
  );
}
