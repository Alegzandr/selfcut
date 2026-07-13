import { useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { useStore, projectDurationMs } from '../store/store';
import { TrackRow } from './TrackRow';
import { Ruler } from './Ruler';
import { Playhead } from './Playhead';
import { TIMELINE_PAD_LEFT } from '../app/config';
import { useImport } from '../ui/useImport';

export function Timeline() {
  const project = useStore((s) => s.project);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const importing = useStore((s) => s.importing);
  const importFiles = useImport();
  const scrollerRef = useRef<HTMLDivElement>(null);

  const pxPerMs = pxPerSec / 1000;
  const durationMs = projectDurationMs(project);
  const contentWidth = TIMELINE_PAD_LEFT + (durationMs + 60_000) * pxPerMs;

  // Wheel zoom, anchored at the cursor (needs passive: false to prevent scrolling).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const state = useStore.getState();
      const factor = Math.exp(-e.deltaY * 0.0018);
      const rect = scroller.getBoundingClientRect();
      const contentX = scroller.scrollLeft + e.clientX - rect.left;
      const anchorMs = (contentX - TIMELINE_PAD_LEFT) / (state.pxPerSec / 1000);
      state.setPxPerSec(state.pxPerSec * factor);
      const newPxPerMs = useStore.getState().pxPerSec / 1000;
      scroller.scrollLeft = anchorMs * newPxPerMs + TIMELINE_PAD_LEFT - (e.clientX - rect.left);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, []);

  // Two-finger pinch zoom (mobile).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartPxPerSec = 0;

    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartPxPerSec = useStore.getState().pxPerSec;
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
      if (pointers.size < 2) pinchStartDist = 0;
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
  }, []);

  if (project.tracks.length === 0) {
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

  return (
    <div
      ref={scrollerRef}
      className="timeline-scroller min-h-0 flex-1 overflow-auto overscroll-none bg-zinc-950"
    >
      <div
        data-timeline-content
        className="relative min-h-full"
        style={{ width: contentWidth, minWidth: '100%' }}
      >
        <Ruler durationMs={durationMs} pxPerMs={pxPerMs} />
        <div
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.rowbg !== undefined) selectClip(null);
          }}
        >
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

        <Playhead scrollerRef={scrollerRef} />
      </div>
    </div>
  );
}
