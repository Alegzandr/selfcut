/**
 * The ramp, big enough to shape.
 *
 * The line drawn on the clip is the read-out: it says what the speed does,
 * where it happens, and it takes a drag on a desktop. It cannot be the whole
 * editor - a track is 36 px tall at its shortest, and a 44 px touch target on a
 * 28 px clip is clipped by the clip's own overflow. So the graph lives here,
 * next to the presets that created it, at a size where a point can be grabbed
 * with a thumb.
 *
 * X IS SOURCE TIME, not timeline time. The clip's line is drawn in timeline
 * time because that is what plays; this graph is where the curve is authored,
 * and in timeline time every vertical drag would also move every point sideways
 * (the durations it changes are the axis it is drawn on). Source time is the
 * space the keys actually live in, so a point goes where it is put and stays
 * there.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from '../../app/config';
import type { Clip, EaseId, Keyframe } from '../../types';
import { EASE_IDS, keyShape, rateAt, removeKeyframe, sampleChannel, setKeyframe } from '../../model';
import { KeyframeIcon } from '../../timeline/KeyframeIcon';
import { linePosToRate, rateToLinePos, snapRate } from '../../timeline/velocityLine';
import { CLIP_COLORS } from '../../lib/palette';
import { speedX } from '../format';
import { useIsCoarsePointer } from '../../lib/device';

/** Graph box in local SVG units, matching the curve editor's proportions. */
const W = 240;
const H = 110;
const PAD_X = 30;
const PAD_Y = 10;

const gx = (p: number) => PAD_X + p * (W - PAD_X * 2);
const gy = (rate: number) => PAD_Y + (1 - rateToLinePos(rate)) * (H - PAD_Y * 2);
const ux = (x: number) => (x - PAD_X) / (W - PAD_X * 2);
const uy = (y: number) => linePosToRate(1 - (y - PAD_Y) / (H - PAD_Y * 2));

const clampRate = (rate: number) => Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, rate));

/** Rates that get a horizontal guide: the octaves either side of unity. */
const GUIDES = [0.25, 0.5, 1, 2, 4];

export function RampEditor({ clip }: { clip: Clip & { velocity: Keyframe[] } }) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const coarse = useIsCoarsePointer();
  const dragging = useRef<number | null>(null);
  const [active, setActive] = useState(0);

  const span = Math.max(1, clip.sourceOutMs - clip.sourceInMs);
  const keys = clip.velocity;
  const selected = keys[Math.min(active, keys.length - 1)];

  /** Pointer position in local SVG units. */
  const toLocal = (e: ReactPointerEvent | React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const write = (next: Keyframe[], commit: boolean) => {
    const store = useStore.getState();
    if (commit) store.updateClipCommitted(clip.id, { velocity: next });
    else store.updateClip(clip.id, { velocity: next });
  };

  const onPointerDown = (e: ReactPointerEvent, index: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragging.current = index;
    setActive(index);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const index = dragging.current;
    if (index === null) return;
    const { x, y } = toLocal(e);
    const raw = clampRate(uy(y));
    const rate = e.altKey ? raw : clampRate(snapRate(raw));
    // Between its neighbours, never across them: two keys at the same instant
    // would make the curve ambiguous and the list unsortable.
    const lo = index > 0 ? keys[index - 1]!.t + 1 : 0;
    const hi = index < keys.length - 1 ? keys[index + 1]!.t - 1 : span;
    const tMs = Math.min(hi, Math.max(lo, ux(x) * span));
    const next = keys.map((k, i) =>
      i === index ? { ...k, t: tMs, value: rate / clip.speed } : { ...k },
    );
    write(next, false);
  };

  const endDrag = () => {
    if (dragging.current === null) return;
    dragging.current = null;
    // The live writes hold the values already; one committed write is what makes
    // the whole drag a single undo step.
    const project = useStore.getState().project;
    const found = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clip.id);
    if (found?.velocity) write(found.velocity, true);
  };

  /** Add a point where the graph was clicked, at the rate the curve already has. */
  const addPoint = (e: React.MouseEvent) => {
    const { x } = toLocal(e);
    const tMs = Math.min(span, Math.max(0, ux(x) * span));
    write(setKeyframe(keys, tMs, sampleChannel(keys, tMs)) as Keyframe[], true);
  };

  const removePoint = (index: number) => {
    const key = keys[index];
    // The last point is the ramp: removing it would leave a curve with nothing
    // to interpolate. "Remove ramp" in the row above is that gesture, and it
    // says what it does.
    if (!key || keys.length <= 2) return;
    const next = removeKeyframe(keys, key.t);
    if (Array.isArray(next)) write(next, true);
  };

  const setEase = (ease: EaseId) => {
    if (!selected) return;
    const next = keys.map((k) =>
      k === selected ? { t: k.t, value: k.value, ease } : { ...k },
    );
    write(next, true);
  };

  const curve: string[] = [];
  for (let i = 0; i <= 96; i++) {
    const p = i / 96;
    curve.push(`${gx(p).toFixed(2)},${gy(rateAt(clip, p * span)).toFixed(2)}`);
  }

  /**
   * Keyboard editing of a point, so the ramp is not a pointer-only control.
   * Up/Down walk the rate by a quarter octave (a twelfth with Shift, for the
   * values between the round ones); Left/Right slide the moment by a twentieth
   * of the window; Delete removes the point.
   */
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const key = keys[index];
    if (!key) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removePoint(index);
      return;
    }
    const vertical = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    const horizontal = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!vertical && !horizontal) return;
    e.preventDefault();
    setActive(index);
    const lo = index > 0 ? keys[index - 1]!.t + 1 : 0;
    const hi = index < keys.length - 1 ? keys[index + 1]!.t - 1 : span;
    const rate = vertical
      ? clampRate(rateAt(clip, key.t) * 2 ** ((e.shiftKey ? 1 / 12 : 1 / 4) * vertical))
      : rateAt(clip, key.t);
    const tMs = horizontal
      ? Math.min(hi, Math.max(lo, key.t + horizontal * (span / 20)))
      : key.t;
    write(
      keys.map((k, i) => (i === index ? { ...k, t: tMs, value: rate / clip.speed } : { ...k })),
      true,
    );
  };

  const hit = coarse ? 22 : 13;

  return (
    <div className="space-y-2">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none rounded-md border border-zinc-800 bg-zinc-900/60"
        onDoubleClick={(e) => {
          e.stopPropagation();
          addPoint(e);
        }}
        role="group"
        aria-label={t('inspector.speed.ramp')}
      >
        {GUIDES.map((rate) => (
          <g key={rate}>
            <line
              x1={PAD_X}
              y1={gy(rate)}
              x2={W - PAD_X}
              y2={gy(rate)}
              stroke={rate === 1 ? CLIP_COLORS.velocityUnity : '#27272a'}
              strokeWidth={1}
              strokeDasharray={rate === 1 ? '3 3' : undefined}
            />
            <text
              x={PAD_X - 4}
              y={gy(rate) + 3}
              textAnchor="end"
              className="fill-zinc-500"
              style={{ fontSize: 8 }}
            >
              {speedX(rate)}
            </text>
          </g>
        ))}

        <path
          d={`M${curve.join(' L')}`}
          fill="none"
          stroke={CLIP_COLORS.velocityRamp}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {keys.map((key, index) => {
          const cx = gx(Math.min(1, Math.max(0, key.t / span)));
          const cy = gy(rateAt(clip, key.t));
          return (
            <g key={index}>
              {/* Transparent, generous hit box under the glyph: the glyph stays
                  small enough to read the curve through, the target does not. */}
              <rect
                x={cx - hit / 2}
                y={cy - hit / 2}
                width={hit}
                height={hit}
                fill="transparent"
                className="cursor-ns-resize outline-none focus-visible:fill-rose-300/20"
                tabIndex={0}
                role="slider"
                aria-label={t('clip.velocity.point', { rate: speedX(rateAt(clip, key.t)) })}
                aria-valuemin={MIN_CLIP_SPEED}
                aria-valuemax={MAX_CLIP_SPEED}
                aria-valuenow={Number(rateAt(clip, key.t).toFixed(2))}
                aria-valuetext={speedX(rateAt(clip, key.t))}
                onFocus={() => setActive(index)}
                onKeyDown={(e) => onKeyDown(e, index)}
                onPointerDown={(e) => onPointerDown(e, index)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  removePoint(index);
                }}
              />
              <KeyframeIcon
                shape={keyShape(key)}
                tone={key === selected ? 'selected' : 'idle'}
                className="pointer-events-none"
                x={cx - 5}
                y={cy - 5}
                width={10}
                height={10}
              />
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-2xs text-zinc-500">{t('inspector.easing')}</span>
        {EASE_IDS.map((ease) => (
          <button
            key={ease}
            type="button"
            onClick={() => setEase(ease)}
            className={`touch-hit rounded px-1.5 py-0.5 text-2xs outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              (selected?.ease ?? 'inOut') === ease && !selected?.bezier
                ? 'brand-on'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700/60'
            }`}
          >
            {t(`inspector.easing.${ease}` as 'inspector.easing.linear')}
          </button>
        ))}
      </div>
    </div>
  );
}
