import { useRef } from 'react';
import { useStore, getSelectedClip } from '../store/store';
import { resolveMaskMotion } from '../model';
import type { BezierPoint, ClipRedaction } from '../types';

/**
 * Direct manipulation of a clip's redaction regions, right on the monitor.
 *
 * Placing a blur through four sliders is the kind of thing that makes people
 * decide the feature does not work: you cannot see the face while you read the
 * numbers. Here the region is the thing you drag, over the frame it is hiding.
 *
 * Every region of the SELECTED clip is drawn; the open one (the one the
 * inspector has expanded) takes the handles, the others are outlines that select
 * themselves when clicked. Coordinates are fractions of the output frame — the
 * same space redactions store — and the stage this sits in IS the output frame,
 * so a percentage maps straight through at any preview zoom.
 */

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** Smallest region the handles will resize to, as a fraction of the frame. */
const MIN_SIZE = 0.02;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** SVG `d` for a closed bezier region, in output pixels. */
function pathD(points: BezierPoint[], outW: number, outH: number): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x * outW} ${points[0]!.y * outH}`;
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const c1 = cur.out ?? cur;
    const c2 = next.in ?? next;
    d += ` C ${c1.x * outW} ${c1.y * outH} ${c2.x * outW} ${c2.y * outH} ${next.x * outW} ${next.y * outH}`;
  }
  return `${d} Z`;
}

/** Bounding-box centre of a path, in output pixels — the pivot its motion turns around. */
function pathCenter(points: BezierPoint[], outW: number, outH: number): { cx: number; cy: number } {
  const xs = points.map((p) => p.x * outW);
  const ys = points.map((p) => p.y * outH);
  return {
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

export function RedactionOverlay({ outW, outH }: { outW: number; outH: number }) {
  const clip = useStore(getSelectedClip);
  const previewTool = useStore((s) => s.previewTool);
  const selectedId = useStore((s) => s.selectedRedactionId);
  // Subscribed: a tracked region moves under the playhead, and its outline has
  // to move with it or it stops meaning anything.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    handle: Handle;
    id: string;
    startX: number;
    startY: number;
    orig: ClipRedaction;
    rect: DOMRect;
  } | null>(null);

  const regions = clip?.redactions ?? [];
  // The pen tool draws into the open region, and its own overlay is what should
  // receive those clicks: standing in front of it would eat every anchor.
  if (!clip || regions.length === 0 || previewTool !== 'select') return null;

  const norm = (e: React.PointerEvent, rect: DOMRect) => ({
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  });

  const onDown = (e: React.PointerEvent, region: ClipRedaction, handle: Handle) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The stage under this listens for clip selection and camera drags: a grab
    // on a region is neither.
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = rootRef.current!.getBoundingClientRect();
    const { x, y } = norm(e, rect);
    const st = useStore.getState();
    st.setSelectedRedactionId(region.id);
    st.beginGesture();
    drag.current = { handle, id: region.id, startX: x, startY: y, orig: region, rect };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = norm(e, d.rect);
    const o = d.orig;
    const motion = resolveMaskMotion(o, currentTimeMs - clip.timelineStartMs);
    // The handles are drawn on the region AFTER its motion transform, so the
    // pointer delta has to be taken back through that transform before it can
    // be added to the geometry the user is actually editing. Without this, a
    // tracked (rotated, scaled) region would drift sideways as you drag it.
    const rad = (-motion.rotation * Math.PI) / 180;
    const rx = (x - d.startX) * Math.cos(rad) - (y - d.startY) * Math.sin(rad);
    const ry = (x - d.startX) * Math.sin(rad) + (y - d.startY) * Math.cos(rad);
    const scale = motion.scale || 1;
    const dx = rx / scale;
    const dy = ry / scale;

    let patch: Partial<ClipRedaction>;
    if (d.handle === 'move') {
      patch = { x: clamp01(o.x + dx), y: clamp01(o.y + dy) };
    } else {
      // Corner resize: the opposite corner stays pinned, so the region grows
      // the way the hand expects rather than around its own centre.
      const left = d.handle === 'nw' || d.handle === 'sw';
      const top = d.handle === 'nw' || d.handle === 'ne';
      const w = Math.max(MIN_SIZE, o.w + (left ? -dx : dx));
      const h = Math.max(MIN_SIZE, o.h + (top ? -dy : dy));
      patch = { w, h, x: o.x + (left ? o.w - w : w - o.w) / 2, y: o.y + (top ? o.h - h : h - o.h) / 2 };
    }
    useStore.getState().setClipRedaction(clip.id, d.id, patch);
  };

  const onUp = () => {
    if (!drag.current) return;
    useStore.getState().endGesture();
    drag.current = null;
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-20">
      {regions.map((region) => {
        const open = region.id === selectedId;
        const motion = resolveMaskMotion(region, currentTimeMs - clip.timelineStartMs);
        const stroke = region.disabled
          ? 'border-zinc-500/50'
          : open
            ? 'border-brand-300'
            : 'border-brand-300/45';

        if (region.shape === 'path') {
          // A drawn path has no box to grab: the pen tool owns its anchors, so
          // the overlay only says where it is and lets a click open it. The
          // transform is the one `applyMask` stamps the shape with, in the same
          // order, so the outline sits exactly on the blur it describes.
          const points = region.path ?? [];
          const { cx, cy } = pathCenter(points, outW, outH);
          return (
            <svg
              key={region.id}
              viewBox={`0 0 ${outW} ${outH}`}
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              <path
                d={pathD(points, outW, outH)}
                fill="none"
                stroke="currentColor"
                strokeWidth={open ? 2 : 1.5}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
                className={`pointer-events-auto ${open ? 'text-brand-300' : 'text-brand-300/45'}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  useStore.getState().setSelectedRedactionId(region.id);
                }}
                transform={
                  `translate(${motion.tx * outW} ${motion.ty * outH}) translate(${cx} ${cy}) ` +
                  `rotate(${motion.rotation}) scale(${motion.scale}) translate(${-cx} ${-cy})`
                }
              />
            </svg>
          );
        }

        const w = region.w * motion.scale;
        const h = region.h * motion.scale;
        return (
          <div
            key={region.id}
            className={`pointer-events-auto absolute touch-none border-2 border-dashed ${stroke} ${
              open ? 'cursor-move bg-brand-400/5' : 'cursor-pointer'
            } ${region.shape === 'ellipse' ? 'rounded-[50%]' : ''}`}
            style={{
              left: `${(region.x + motion.tx - w / 2) * 100}%`,
              top: `${(region.y + motion.ty - h / 2) * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              transform: motion.rotation ? `rotate(${motion.rotation}deg)` : undefined,
            }}
            onPointerDown={(e) => onDown(e, region, 'move')}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {open &&
              (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <div
                  key={corner}
                  className={`absolute h-3 w-3 rounded-sm border border-zinc-900 bg-brand-300 shadow ${
                    corner[0] === 'n' ? '-top-1.5' : '-bottom-1.5'
                  } ${corner[1] === 'w' ? '-left-1.5' : '-right-1.5'} ${
                    corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'
                  }`}
                  onPointerDown={(e) => onDown(e, region, corner)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
