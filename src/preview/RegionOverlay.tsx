import { useRef } from 'react';
import { useStore, getSelectedClip } from '../store/store';
import { resolveMaskMotion } from '../model';
import type { BezierPoint, Clip, ClipMask } from '../types';

/**
 * Direct manipulation of a clip's shaped regions, right on the monitor.
 *
 * Placing a blur - or a grade - through four sliders is the kind of thing that
 * makes people decide the feature does not work: you cannot see the face while
 * you read the numbers. Here the region is the thing you drag, over the frame it
 * is acting on.
 *
 * Every region of the SELECTED clip is drawn; the open one (the one the
 * inspector has expanded) takes the handles, the others are outlines that select
 * themselves when clicked. Coordinates are fractions of the output frame — the
 * same space every mask-shaped thing stores — and the stage this sits in IS the
 * output frame, so a percentage maps straight through at any preview zoom.
 *
 * One component, two callers: redactions and local adjustments are the same
 * shape on the same frame, and only their colour on screen and where their edits
 * go differ. They are told apart by that colour, because a region that hides and
 * a region that grades look identical until you know which is which.
 */

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** What the overlay needs of a region: a mask, an identity, and a mute flag. */
export interface ShapedRegion extends ClipMask {
  id: string;
  disabled?: boolean;
}

/** The two families' colours on the monitor. Tailwind classes, so: written out. */
const TONES = {
  redaction: {
    open: 'text-blue-300',
    dim: 'text-blue-300/45',
    border: 'border-blue-300',
    borderDim: 'border-blue-300/45',
    fill: 'bg-blue-400/5',
    handle: 'bg-blue-300',
  },
  adjust: {
    open: 'text-amber-300',
    dim: 'text-amber-300/45',
    border: 'border-amber-300',
    borderDim: 'border-amber-300/45',
    fill: 'bg-amber-400/5',
    handle: 'bg-amber-300',
  },
} as const;

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

function RegionOverlay({
  clip,
  regions,
  selectedId,
  tone,
  outW,
  outH,
  onSelect,
  onPatch,
}: {
  clip: Clip;
  regions: ShapedRegion[];
  selectedId: string | null;
  tone: keyof typeof TONES;
  outW: number;
  outH: number;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<ShapedRegion>) => void;
}) {
  // Subscribed: a tracked region moves under the playhead, and its outline has
  // to move with it or it stops meaning anything.
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    handle: Handle;
    id: string;
    startX: number;
    startY: number;
    orig: ShapedRegion;
    rect: DOMRect;
  } | null>(null);
  const c = TONES[tone];

  const norm = (e: React.PointerEvent, rect: DOMRect) => ({
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  });

  const onDown = (e: React.PointerEvent, region: ShapedRegion, handle: Handle) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The stage under this listens for clip selection and camera drags: a grab
    // on a region is neither.
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = rootRef.current!.getBoundingClientRect();
    const { x, y } = norm(e, rect);
    onSelect(region.id);
    useStore.getState().beginGesture();
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

    let patch: Partial<ShapedRegion>;
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
    onPatch(d.id, patch);
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
        const stroke = region.disabled ? 'border-zinc-500/50' : open ? c.border : c.borderDim;

        if (region.shape === 'path') {
          // A drawn path has no box to grab: the pen tool owns its anchors, so
          // the overlay only says where it is and lets a click open it. The
          // transform is the one `applyMask` stamps the shape with, in the same
          // order, so the outline sits exactly on the region it describes.
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
                className={`pointer-events-auto ${open ? c.open : c.dim}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(region.id);
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
              open ? `cursor-move ${c.fill}` : 'cursor-pointer'
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
                  className={`absolute h-3 w-3 rounded-sm border border-zinc-900 ${c.handle} shadow ${
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

/** The redaction regions of the selected clip: blue, hiding what they cover. */
export function RedactionOverlay({ outW, outH }: { outW: number; outH: number }) {
  const clip = useStore(getSelectedClip);
  const previewTool = useStore((s) => s.previewTool);
  const selectedId = useStore((s) => s.selectedRedactionId);
  const regions = clip?.redactions ?? [];
  // The pen tool draws into the open region, and its own overlay is what should
  // receive those clicks: standing in front of it would eat every anchor.
  if (!clip || regions.length === 0 || previewTool !== 'select') return null;
  return (
    <RegionOverlay
      clip={clip}
      regions={regions}
      selectedId={selectedId}
      tone="redaction"
      outW={outW}
      outH={outH}
      onSelect={(id) => useStore.getState().setSelectedRedactionId(id)}
      onPatch={(id, patch) => useStore.getState().setClipRedaction(clip.id, id, patch)}
    />
  );
}

/** The local-adjustment regions of the selected clip: amber, grading what they cover. */
export function LocalAdjustOverlay({ outW, outH }: { outW: number; outH: number }) {
  const clip = useStore(getSelectedClip);
  const previewTool = useStore((s) => s.previewTool);
  const selectedId = useStore((s) => s.selectedLocalAdjustId);
  const regions = clip?.localAdjusts ?? [];
  if (!clip || regions.length === 0 || previewTool !== 'select') return null;
  return (
    <RegionOverlay
      clip={clip}
      regions={regions}
      selectedId={selectedId}
      tone="adjust"
      outW={outW}
      outH={outH}
      onSelect={(id) => useStore.getState().setSelectedLocalAdjustId(id)}
      onPatch={(id, patch) => useStore.getState().setClipLocalAdjust(clip.id, id, patch)}
    />
  );
}
