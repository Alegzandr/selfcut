import { useRef, useState } from 'react';
import { useStore, getSelectedClip } from '../store/store';
import { BezierPoint } from '../types';

/**
 * Pen-tool overlay for bezier mask paths — draw and edit, right on the monitor.
 *
 * Two modes, chosen by the active tool and selection:
 *  - draw   (pen tool): click to drop an anchor, drag to pull smooth tangent
 *           handles; click the first anchor again to close the path into a mask.
 *  - edit   (select tool + the selected clip has a path mask): drag anchors and
 *           their handles to reshape.
 *
 * Coordinates are fractions of the output frame (0..1) — the same space masks
 * store — so the SVG's viewBox is the output size and a pointer position maps
 * straight through. Desktop only: this is a fine-pointer tool.
 */

/** Pointer hit radius for grabbing an anchor/handle, and for closing the path. */
const HIT = 0.022;

type EditTarget = { kind: 'anchor' | 'in' | 'out'; index: number; orig: BezierPoint; startX: number; startY: number };

function mirror(anchor: { x: number; y: number }, h: { x: number; y: number }): { x: number; y: number } {
  return { x: 2 * anchor.x - h.x, y: 2 * anchor.y - h.y };
}

/** SVG path `d` for a closed bezier loop, in output px. */
function pathD(points: BezierPoint[], outW: number, outH: number): string {
  if (points.length === 0) return '';
  const px = (v: number, s: number) => v * s;
  let d = `M ${px(points[0]!.x, outW)} ${px(points[0]!.y, outH)}`;
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const c1 = cur.out ?? { x: cur.x, y: cur.y };
    const c2 = next.in ?? { x: next.x, y: next.y };
    d += ` C ${px(c1.x, outW)} ${px(c1.y, outH)} ${px(c2.x, outW)} ${px(c2.y, outH)} ${px(next.x, outW)} ${px(next.y, outH)}`;
  }
  return d;
}

export function MaskPenOverlay({ outW, outH }: { outW: number; outH: number }) {
  const previewTool = useStore((s) => s.previewTool);
  const selected = useStore(getSelectedClip);
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<BezierPoint[]>([]);
  const placing = useRef<{ index: number } | null>(null);
  const editing = useRef<EditTarget | null>(null);

  const drawing = previewTool === 'pen';
  const pathMask = selected?.mask?.shape === 'path' ? selected.mask : undefined;
  const editable = !drawing && !!pathMask && previewTool === 'select';

  // Nothing to do: let clicks fall through to the clip drag/selection below.
  if (!drawing && !editable) return null;

  const toNorm = (e: React.PointerEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot((a.x - b.x) * outW, (a.y - b.y) * outH) / outW;

  const finalize = (points: BezierPoint[]) => {
    const st = useStore.getState();
    setDraft([]);
    placing.current = null;
    st.setPreviewTool('select');
    // A closed area needs at least three anchors; anything less is discarded.
    if (points.length < 3 || !selected) return;
    const ex = selected.mask;
    st.beginGesture();
    st.setClipMask(selected.id, {
      shape: 'path',
      x: ex?.x ?? 0.5,
      y: ex?.y ?? 0.5,
      w: ex?.w ?? 1,
      h: ex?.h ?? 1,
      feather: ex?.feather ?? 0.02,
      invert: ex?.invert,
      motion: ex?.motion,
      path: points,
    });
    st.endGesture();
  };

  const setPath = (points: BezierPoint[]) => {
    if (!pathMask || !selected) return;
    useStore.getState().setClipMask(selected.id, { ...pathMask, path: points });
  };

  // Draw mode only (in edit mode the SVG is click-through and the anchors/handles
  // capture their own drags, so empty clicks still reach the clip below).
  const onDrawDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!drawing || !selected) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toNorm(e);
    if (draft.length >= 2 && dist(p, draft[0]!) < HIT) {
      finalize(draft);
      return;
    }
    const next = [...draft, { x: p.x, y: p.y }];
    placing.current = { index: next.length - 1 };
    setDraft(next);
  };

  const onEditDown = (kind: EditTarget['kind'], index: number) => (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toNorm(e);
    editing.current = { kind, index, orig: JSON.parse(JSON.stringify(pathMask!.path![index]!)), startX: p.x, startY: p.y };
    useStore.getState().beginGesture();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toNorm(e);
    if (drawing && placing.current) {
      // Pull symmetric tangent handles out of the anchor being placed.
      const i = placing.current.index;
      const next = draft.map((pt, idx) =>
        idx === i ? { x: pt.x, y: pt.y, out: { x: p.x, y: p.y }, in: mirror(pt, p) } : pt,
      );
      setDraft(next);
      return;
    }
    const ed = editing.current;
    if (!ed || !pathMask) return;
    const path = pathMask.path!;
    const dx = p.x - ed.startX;
    const dy = p.y - ed.startY;
    const o = ed.orig;
    let np: BezierPoint;
    if (ed.kind === 'anchor') {
      // Move the anchor and carry its handles along.
      np = {
        x: o.x + dx,
        y: o.y + dy,
        in: o.in ? { x: o.in.x + dx, y: o.in.y + dy } : undefined,
        out: o.out ? { x: o.out.x + dx, y: o.out.y + dy } : undefined,
      };
    } else {
      // Drag one handle, keep the opposite one mirrored (smooth anchor).
      const anchor = { x: o.x, y: o.y };
      const h = { x: p.x, y: p.y };
      np = ed.kind === 'out' ? { ...o, out: h, in: mirror(anchor, h) } : { ...o, in: h, out: mirror(anchor, h) };
    }
    setPath(path.map((pt, idx) => (idx === ed.index ? np : pt)));
  };

  const onPointerUp = () => {
    placing.current = null;
    if (editing.current) {
      editing.current = null;
      useStore.getState().endGesture();
    }
  };

  const onDoubleClick = () => {
    if (drawing) finalize(draft);
  };

  const px = (v: number, s: number) => v * s;
  const r = outH * 0.011;
  const live = drawing ? draft : pathMask!.path!;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${outW} ${outH}`}
      preserveAspectRatio="none"
      className={`absolute inset-0 z-30 h-full w-full ${drawing ? 'cursor-crosshair' : ''}`}
      // Draw mode owns every click; edit mode is click-through except on the
      // anchors/handles, so the clip underneath stays draggable/selectable.
      style={{ touchAction: 'none', pointerEvents: drawing ? 'auto' : 'none' }}
      onPointerDown={onDrawDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {live.length > 0 && (
        <path
          d={pathD(live, outW, outH) + (drawing && live.length < 2 ? '' : ' Z')}
          fill="rgba(56,189,248,0.12)"
          stroke="#38bdf8"
          strokeWidth={Math.max(1, outH * 0.0025)}
        />
      )}
      {/* Tangent handles (edit + the point being placed). Draggable in edit mode. */}
      {live.map((pt, i) =>
        (['in', 'out'] as const).map((side) => {
          const h = pt[side];
          if (!h) return null;
          return (
            <g key={`${i}-${side}`}>
              <line
                x1={px(pt.x, outW)}
                y1={px(pt.y, outH)}
                x2={px(h.x, outW)}
                y2={px(h.y, outH)}
                stroke="#38bdf8"
                strokeWidth={Math.max(0.5, outH * 0.0015)}
                opacity={0.7}
              />
              <circle
                cx={px(h.x, outW)}
                cy={px(h.y, outH)}
                r={r * 0.85}
                fill="#0ea5e9"
                stroke="#082f49"
                strokeWidth={outH * 0.0015}
                style={{ pointerEvents: editable ? 'auto' : 'none', cursor: 'grab' }}
                onPointerDown={editable ? onEditDown(side, i) : undefined}
                onPointerMove={editable ? onPointerMove : undefined}
                onPointerUp={editable ? onPointerUp : undefined}
              />
            </g>
          );
        }),
      )}
      {/* Anchors. Draggable in edit mode; the first is highlighted while drawing. */}
      {live.map((pt, i) => (
        <rect
          key={`a${i}`}
          x={px(pt.x, outW) - r}
          y={px(pt.y, outH) - r}
          width={r * 2}
          height={r * 2}
          fill={i === 0 && drawing ? '#fbbf24' : '#fff'}
          stroke="#0c4a6e"
          strokeWidth={outH * 0.002}
          style={{ pointerEvents: editable ? 'auto' : 'none', cursor: 'move' }}
          onPointerDown={editable ? onEditDown('anchor', i) : undefined}
          onPointerMove={editable ? onPointerMove : undefined}
          onPointerUp={editable ? onPointerUp : undefined}
        />
      ))}
    </svg>
  );
}
