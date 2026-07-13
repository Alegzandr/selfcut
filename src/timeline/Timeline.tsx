import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { TrackRow } from './TrackRow';
import { Ruler } from './Ruler';
import { Playhead } from './Playhead';
import { TIMELINE_PAD_LEFT } from '../app/config';
import { useImport } from '../ui/useImport';
import { useIsCoarsePointer } from '../lib/device';

export function Timeline() {
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

  // Wheel. Desktop (Vegas-style): plain wheel pans horizontally, Ctrl/Cmd+wheel zooms
  // at the cursor (also covers trackpad pinch), Alt+wheel keeps native vertical scroll.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.ctrlKey || e.metaKey || coarse) {
        e.preventDefault();
        const state = useStore.getState();
        const factor = Math.exp(-e.deltaY * 0.0018);
        const rect = scroller.getBoundingClientRect();
        const pad = state.timelinePadLeft;
        const contentX = scroller.scrollLeft + e.clientX - rect.left;
        const anchorMs = (contentX - pad) / (state.pxPerSec / 1000);
        state.setPxPerSec(state.pxPerSec * factor);
        const newPxPerMs = useStore.getState().pxPerSec / 1000;
        scroller.scrollLeft = anchorMs * newPxPerMs + pad - (e.clientX - rect.left);
      } else if (!e.altKey && !e.shiftKey) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [coarse, empty]);

  // Two-finger pinch zoom + pause playback when the timeline is touched (mobile).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartPxPerSec = 0;

    const onDown = (e: PointerEvent) => {
      if (coarse && e.pointerType === 'touch') {
        const s = useStore.getState();
        if (s.playing) s.setPlaying(false);
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartPxPerSec = useStore.getState().pxPerSec;
        pinching.current = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStartDist > 0) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        useStore.getState().setPxPerSec(pinchStartPxPerSec * (dist / pinchStartDist));
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinchStartDist = 0;
        pinching.current = false;
      }
    };

    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('pointermove', onMove);
    scroller.addEventListener('pointerup', onUp);
    scroller.addEventListener('pointercancel', onUp);
    return () => {
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('pointermove', onMove);
      scroller.removeEventListener('pointerup', onUp);
      scroller.removeEventListener('pointercancel', onUp);
    };
  }, [coarse, empty]);

  // Mobile scroll<->time sync: scrolling scrubs (scrollLeft = t * pxPerMs), and any
  // time/zoom change re-centers the content under the fixed playhead.
  useEffect(() => {
    if (!coarse) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const sync = () => {
      const s = useStore.getState();
      const target = s.currentTimeMs * (s.pxPerSec / 1000);
      if (Math.abs(scroller.scrollLeft - target) > 1) {
        programmaticScroll.current = true;
        scroller.scrollLeft = target;
      }
    };
    sync();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.currentTimeMs !== prev.currentTimeMs || s.pxPerSec !== prev.pxPerSec) sync();
    });

    const onScroll = () => {
      const left = scroller.scrollLeft;
      if (left === lastScrollLeft.current) return; // vertical-only scroll
      lastScrollLeft.current = left;
      if (programmaticScroll.current) {
        programmaticScroll.current = false;
        return;
      }
      if (pinching.current) return;
      const s = useStore.getState();
      if (s.playing) return; // the engine drives time; touching pauses first
      s.seek(left / (s.pxPerSec / 1000));
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      unsub();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [coarse, empty]);

  if (empty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-zinc-500">
          {importing
            ? 'Importing…'
            : 'Drop video or audio files here, then add them from the media library.'}
        </p>
        <label className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 active:bg-zinc-700">
          Choose files
          <input
            type="file"
            accept="video/*,audio/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void importFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    );
  }

  const { addTrack, selectClip } = useStore.getState();

  // Desktop: click on empty track background moves the playhead there (and scrubs while held).
  const seekToClientX = (e: React.PointerEvent) => {
    const content = (e.currentTarget as HTMLElement).closest('[data-timeline-content]') as HTMLElement;
    const rect = content.getBoundingClientRect();
    const s = useStore.getState();
    s.seek((e.clientX - rect.left - s.timelinePadLeft) / (s.pxPerSec / 1000));
  };
  const onBgPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.rowbg === undefined) return;
    selectClip(null);
    if (coarse || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekToClientX(e);
  };
  const onBgPointerMove = (e: React.PointerEvent) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) seekToClientX(e);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className="timeline-scroller h-full overflow-auto overscroll-none bg-zinc-950"
      >
        <div
          data-timeline-content
          className="relative min-h-full"
          style={{ width: contentWidth, minWidth: '100%' }}
        >
          <Ruler durationMs={durationMs} pxPerMs={pxPerMs} overscanMs={coarse ? 0 : 30_000} />
          <div onPointerDown={onBgPointerDown} onPointerMove={onBgPointerMove}>
            {project.tracks.map((track) => (
              <TrackRow key={track.id} track={track} pxPerMs={pxPerMs} />
            ))}
          </div>

          <div className="sticky left-0 flex w-fit gap-2 p-2">
            <button
              className="rounded-md border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
              onClick={() => addTrack('video')}
            >
              <Plus className="mr-1 inline h-3 w-3" />
              Video track
            </button>
            <button
              className="rounded-md border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
              onClick={() => addTrack('audio')}
            >
              <Plus className="mr-1 inline h-3 w-3" />
              Audio track
            </button>
          </div>

          {!coarse && <Playhead scrollerRef={scrollerRef} />}
        </div>
      </div>

      {/* Mobile: fixed playhead at the center of the viewport (the timeline scrolls under it). */}
      {coarse && (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 z-30 w-0.5 -translate-x-1/2 bg-red-500">
          <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-red-500" />
        </div>
      )}
    </div>
  );
}
