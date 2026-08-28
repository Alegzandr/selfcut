/**
 * The curve (graph) editor: the velocity of the selected keyframes, drawn as the
 * cubic-Bezier the renderer actually samples, with two handles to bend it.
 *
 * It lives at the timeline's top-left corner rather than in the inspector on
 * purpose: it edits `selectedKeyframes`, and those are boxed on the timeline
 * lanes. The panel and the diamonds it acts on are then one glance apart.
 *
 * The graph is the CSS/AE convention - progress on X, eased progress on Y,
 * endpoints pinned at (0,0) and (1,1) - so a handle pulled above the top edge
 * overshoots and the motion snaps back, which is the whole reason to leave the
 * unit square reachable.
 *
 * A `linear` key gets handles lying flat on the diagonal, so bending one is how
 * a straight segment becomes a curve. A `hold` key gets none - a step has no
 * velocity to shape - and neither does a selection whose keys disagree: the
 * presets below the graph are the way out of both.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { EASE_IDS, easeAt } from '../model';
import type { EaseId, Keyframe } from '../types';
import { selectedKeys, selectionBezier, selectionEase } from './keyframeSelection';
import { MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../app/config';

/** A straight line as control points: the seed a `linear` key is bent from. */
const LINEAR_BEZIER: [number, number, number, number] = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/** Graph box in local SVG units. The unit square sits inside the margins. */
const PAD_X = 14;
const PAD_Y = 26;
const SIZE = 132;
const W = SIZE + PAD_X * 2;
const H = SIZE + PAD_Y * 2;

/** Vertical headroom, as a fraction of the unit square, for overshoot handles. */
const OVERSHOOT = PAD_Y / SIZE;

const gx = (x: number) => PAD_X + x * SIZE;
const gy = (y: number) => PAD_Y + (1 - y) * SIZE;
/** Inverse of `gx`/`gy`, for a pointer position expressed in local units. */
const ux = (px: number) => (px - PAD_X) / SIZE;
const uy = (py: number) => 1 - (py - PAD_Y) / SIZE;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The curve of a key, sampled into an SVG polyline through the graph. */
function curvePath(key: Keyframe): string {
  const steps = 48;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    pts.push(`${gx(p).toFixed(2)},${gy(easeAt(key, p)).toFixed(2)}`);
  }
  return `M${pts.join(' L')}`;
}

export function CurveEditor() {
  const { t } = useTranslation();
  const open = useStore((s) => s.curveEditorOpen);
  const project = useStore((s) => s.project);
  const refs = useStore((s) => s.selectedKeyframes);
  const svgRef = useRef<SVGSVGElement>(null);
  // Which handle is being dragged, if any. A ref, not state: the drag writes
  // straight to the store and the panel re-renders from it.
  const dragging = useRef<1 | 2 | null>(null);

  if (!open) return null;

  const keys = selectedKeys(project, refs);
  const ease = selectionEase(project, refs);
  const bezier = selectionBezier(project, refs);
  const close = () => useStore.getState().setCurveEditorOpen(false);

  /** Pointer position in local SVG units (viewBox space), from a client point. */
  const toLocal = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H,
    };
  };

  const onHandleDown = (e: React.PointerEvent, which: 1 | 2) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragging.current = which;
    // One history entry for the whole bend, like a clip drag.
    useStore.getState().beginGesture();
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const which = dragging.current;
    if (which === null) return;
    const base = bezier ?? LINEAR_BEZIER;
    const { x, y } = toLocal(e.clientX, e.clientY);
    // X stays inside [0,1] - a control point past the endpoints makes the curve
    // fold back on itself, and a non-monotonic easing is not a thing a timeline
    // can play. Y is free to overshoot within the panel's headroom.
    const cx = clamp(ux(x), 0, 1);
    const cy = clamp(uy(y), -OVERSHOOT, 1 + OVERSHOOT);
    const next: [number, number, number, number] =
      which === 1 ? [cx, cy, base[2]!, base[3]!] : [base[0]!, base[1]!, cx, cy];
    useStore.getState().setSelectedKeyframesBezier(next);
  };
  const onHandleUp = () => {
    if (dragging.current === null) return;
    dragging.current = null;
    useStore.getState().endGesture();
  };

  const preview = keys[0];
  // `linear` gets handles too, lying flat on the diagonal: bending one is how a
  // straight segment becomes a curve. `hold` gets none - a step has no velocity
  // to shape - and neither does a mixed selection, whose keys disagree.
  const handles = bezier ?? (ease === 'linear' ? LINEAR_BEZIER : null);

  return (
    <div
      className="absolute left-2 z-40 w-[220px] rounded-lg border border-zinc-700 bg-zinc-900/95 p-2 shadow-xl shadow-black/50 backdrop-blur"
      // Hangs from its corner button, clearing the ruler. Anchored over the
      // track-header pane rather than the lanes: a panel that hid the very
      // diamonds it edits would be worse than no panel.
      style={{ top: MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX + 6 }}
      // The panel floats over the tracks; a right-click on it belongs to it, not
      // to the clip underneath.
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between pb-1.5">
        <span className="text-2xs font-medium uppercase tracking-wide text-zinc-400">
          {t('timeline.curveEditor')}
        </span>
        <button
          type="button"
          aria-label={t('inspector.close')}
          className="touch-hit rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={close}
        >
          <Cross2Icon className="h-3.5 w-3.5" />
        </button>
      </div>

      {!keys.length ? (
        <p className="px-1 pb-1 text-2xs leading-relaxed text-zinc-500">
          {t('timeline.curveEditor.empty')}
        </p>
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            // A fixed height, not a width-driven square: the panel has to fit
            // inside a timeline that is often only a few hundred px tall.
            className="mx-auto block h-[150px] w-full touch-none select-none"
            role="img"
            aria-label={t('timeline.curveEditor')}
          >
            {/* Unit square: the frame the curve is read against. */}
            <rect
              x={gx(0)}
              y={gy(1)}
              width={SIZE}
              height={SIZE}
              className="fill-zinc-950 stroke-zinc-800"
              strokeWidth={1}
            />
            {/* The straight line the curve is judged against - linear motion. */}
            <line
              x1={gx(0)}
              y1={gy(0)}
              x2={gx(1)}
              y2={gy(1)}
              className="stroke-zinc-800"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {preview && (
              <path d={curvePath(preview)} className="fill-none stroke-blue-400" strokeWidth={2} />
            )}
            {handles && (
              <>
                <line
                  x1={gx(0)}
                  y1={gy(0)}
                  x2={gx(handles[0])}
                  y2={gy(handles[1])}
                  className="stroke-zinc-600"
                  strokeWidth={1}
                />
                <line
                  x1={gx(1)}
                  y1={gy(1)}
                  x2={gx(handles[2])}
                  y2={gy(handles[3])}
                  className="stroke-zinc-600"
                  strokeWidth={1}
                />
                {([1, 2] as const).map((which) => (
                  <circle
                    key={which}
                    cx={gx(handles[which === 1 ? 0 : 2])}
                    cy={gy(handles[which === 1 ? 1 : 3])}
                    r={5}
                    className="cursor-grab fill-blue-400 stroke-zinc-950 active:cursor-grabbing"
                    strokeWidth={1.5}
                    onPointerDown={(e) => onHandleDown(e, which)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                  />
                ))}
              </>
            )}
            {/* Both ends are pinned: a keyframe's segment starts at its value and
                ends at the next one, so only the middle is negotiable. */}
            <circle cx={gx(0)} cy={gy(0)} r={2.5} className="fill-zinc-500" />
            <circle cx={gx(1)} cy={gy(1)} r={2.5} className="fill-zinc-500" />
          </svg>

          <div className="flex flex-wrap gap-1 pt-1.5">
            {EASE_IDS.map((id) => (
              <PresetButton key={id} id={id} active={ease === id} />
            ))}
          </div>
          <p className="pt-1.5 text-3xs tabular-nums text-zinc-500">
            {ease === null
              ? t('timeline.curveEditor.mixed')
              : handles
                ? `cubic-bezier(${handles.map((v) => v.toFixed(2)).join(', ')})`
                : t(`inspector.easing.${ease}`)}
          </p>
        </>
      )}
    </div>
  );
}

function PresetButton({ id, active }: { id: EaseId; active: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`touch-hit rounded px-1.5 py-1 text-2xs ${
        active ? 'brand-on' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700'
      }`}
      onClick={() => useStore.getState().setSelectedKeyframesEase(id)}
    >
      {t(`inspector.easing.${id}`)}
    </button>
  );
}
