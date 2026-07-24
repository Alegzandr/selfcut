import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useStore } from '../../store/store';
import { Clip, ClipCurves, CurvePoint } from '../../types';
import { CURVE_CHANNELS, IDENTITY_POINTS, type CurveChannel } from '../../model';

/**
 * Tone-curve editor: the point-curve tool a colourist reaches for after the
 * sliders. Drag on the grid to add or move a point, drag an existing one to
 * reshape the response, double-click to remove it. The master (RGB) curve maps
 * every channel; the R/G/B tabs map one each, for colour balancing.
 *
 * The curve lives in `clip.color.curves` and grades through the same WebGL pass
 * as the sliders — so preview and export stay identical — and every edit is one
 * gesture, hence one undo step, exactly like the transform handles.
 */

/** viewBox side; the SVG scales to the panel but the maths stays in 0..100. */
const VB = 100;
/** Pointer hit radius for grabbing a point, in normalized (0..1) distance. */
const HIT = 0.07;
/** Minimum x gap kept between interior points, normalized, so order never flips. */
const MIN_GAP = 0.02;

const CHANNEL_COLOR: Record<CurveChannel, string> = {
  master: '#e4e4e7',
  r: '#f87171',
  g: '#4ade80',
  b: '#60a5fa',
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The active channel's points, sorted, falling back to the identity ramp. */
function pointsOf(curves: ClipCurves | undefined, ch: CurveChannel): CurvePoint[] {
  const p = curves?.[ch];
  return p && p.length >= 2 ? [...p].sort((a, b) => a.x - b.x) : IDENTITY_POINTS.map((q) => ({ ...q }));
}

export function CurvesSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<CurveChannel>('master');
  const svgRef = useRef<SVGSVGElement>(null);
  // The point list being dragged, held here so fast pointermoves don't depend on
  // React having re-rendered the clip prop between events.
  const drag = useRef<{ index: number; points: CurvePoint[] } | null>(null);

  const curves = clip.color?.curves;
  const pts = pointsOf(curves, channel);

  const commit = (next: CurvePoint[]) => {
    const nextCurves: ClipCurves = { ...(clip.color?.curves ?? {}) };
    nextCurves[channel] = next;
    useStore.getState().setClipCurves(clip.id, nextCurves);
  };

  const toCurve = (e: React.PointerEvent): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01(1 - (e.clientY - rect.top) / rect.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const c = toCurve(e);
    const current = pointsOf(clip.color?.curves, channel);

    let hitIndex = -1;
    let best = HIT;
    current.forEach((p, i) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < best) {
        best = d;
        hitIndex = i;
      }
    });

    useStore.getState().beginGesture();
    if (hitIndex >= 0) {
      drag.current = { index: hitIndex, points: current };
    } else {
      // Empty grid: drop a new interior point here and start dragging it.
      const next = [...current, c].sort((a, b) => a.x - b.x);
      drag.current = { index: next.indexOf(c), points: next };
      commit(next);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const c = toCurve(e);
    const i = d.index;
    const last = d.points.length - 1;
    let x = c.x;
    if (i === 0) x = 0;
    else if (i === last) x = 1;
    else x = Math.min(Math.max(c.x, d.points[i - 1]!.x + MIN_GAP), d.points[i + 1]!.x - MIN_GAP);
    d.points = d.points.map((p, idx) => (idx === i ? { x, y: c.y } : p));
    commit(d.points);
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    useStore.getState().endGesture();
  };

  const removePoint = (i: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const current = pointsOf(clip.color?.curves, channel);
    if (i === 0 || i === current.length - 1) return; // endpoints are anchors
    const st = useStore.getState();
    st.beginGesture();
    commit(current.filter((_, idx) => idx !== i));
    st.endGesture();
  };

  const resetChannel = () => {
    const st = useStore.getState();
    st.beginGesture();
    const nextCurves: ClipCurves = { ...(clip.color?.curves ?? {}) };
    delete nextCurves[channel];
    st.setClipCurves(clip.id, nextCurves);
    st.endGesture();
  };

  const color = CHANNEL_COLOR[channel];
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * VB} ${(1 - p.y) * VB}`).join(' ');
  const channelEdited = !!curves && CURVE_CHANNELS.some((ch) => ch === channel && curves[ch]);

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('inspector.curves')}
        </h3>
        <div className="flex items-center gap-1">
          {CURVE_CHANNELS.map((ch) => (
            <button
              key={ch}
              type="button"
              aria-pressed={channel === ch}
              title={t(`inspector.curves.${ch}`)}
              onClick={() => setChannel(ch)}
              className={`touch-hit rounded px-1.5 py-0.5 text-2xs font-medium ${
                channel === ch
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800'
              }`}
              style={channel === ch ? { color: CHANNEL_COLOR[ch] } : undefined}
            >
              {t(`inspector.curves.${ch}.short`)}
            </button>
          ))}
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB} ${VB}`}
        className="aspect-square w-full touch-none rounded-md border border-zinc-800 bg-zinc-950"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Quarter grid + identity diagonal, the neutral reference. */}
        {[0.25, 0.5, 0.75].map((q) => (
          <g key={q} stroke="#3f3f46" strokeWidth={0.4}>
            <line x1={q * VB} y1={0} x2={q * VB} y2={VB} />
            <line x1={0} y1={q * VB} x2={VB} y2={q * VB} />
          </g>
        ))}
        <line x1={0} y1={VB} x2={VB} y2={0} stroke="#3f3f46" strokeWidth={0.5} strokeDasharray="2 2" />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x * VB}
            cy={(1 - p.y) * VB}
            r={2.4}
            fill={color}
            stroke="#09090b"
            strokeWidth={0.8}
            onDoubleClick={(e) => removePoint(i, e)}
          />
        ))}
      </svg>

      <div className="flex items-center justify-between">
        <span className="text-2xs text-zinc-600">{t('inspector.curves.hint')}</span>
        {channelEdited && (
          <button
            type="button"
            onClick={resetChannel}
            className="touch-hit flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
          >
            <RotateCcw className="h-3 w-3" />
            {t('inspector.reset')}
          </button>
        )}
      </div>
    </div>
  );
}
