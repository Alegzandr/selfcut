/**
 * The speed of a clip, drawn across the clip itself.
 *
 * Same family as `ClipVolumeLine`, and deliberately so: an editor already reads
 * level off a line whose height IS the value, and speed is the other property
 * worth knowing without opening anything. A flat clip gets a flat line it can be
 * dragged by; a ramped one gets the curve, with a point at every keyframe.
 *
 * The vertical axis is logarithmic with 1x in the middle (see `velocityLine`),
 * which is the one place this departs from Vegas on purpose - its envelope is a
 * linear percentage, and that buries every slow motion worth having in the
 * bottom eighth of the clip.
 *
 * Quiet at rest: at exactly 1x with no ramp the line carries no information, so
 * it only appears on hover or selection, right when it becomes draggable. A
 * clip whose speed is actually set keeps it lit.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { CLIP_COLORS } from '../lib/palette';
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from '../app/config';
import type { Clip, Keyframe } from '../types';
import {
  clipDurationMs,
  clipRateAt,
  hasVelocity,
  keyShape,
  rateAt,
  removeKeyframe,
  setKeyframe,
  sourceOffsetAtTimeline,
  timelineAtSourceOffset,
  frozenTailMs,
} from '../model';
import { KeyframeIcon } from './KeyframeIcon';
import { LINE_INSET_PX, rateToTopPx, snapRate, topPxToRate } from './velocityLine';
import { speedX } from '../inspector/format';

/**
 * Grab band around the flat line, in px. The coarse figure is kept for the
 * layout maths only: on touch the band is not interactive (see `editable`).
 */
const GRAB_FINE_PX = 10;
const GRAB_COARSE_PX = 24;
/** Hit box of a ramp point. Fine pointers only, see `pointsEditable` below. */
const POINT_PX = 14;

/** Sampling step of the drawn curve, in px. Below a pixel buys nothing. */
const CURVE_STEP_PX = 2;

const clampRate = (rate: number) => Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, rate));

/** The ramp's curve as an SVG path, in the clip's own pixel space. */
function curvePath(clip: Clip, width: number, height: number): string {
  const durMs = clipDurationMs(clip);
  if (durMs <= 0 || width <= 0) return '';
  const steps = Math.max(2, Math.ceil(width / CURVE_STEP_PX));
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const rate = clipRateAt(clip, clip.timelineStartMs + (i / steps) * durMs);
    points.push(`${x.toFixed(1)},${rateToTopPx(rate, height).toFixed(2)}`);
  }
  return `M${points.join(' L')}`;
}

/** Keys that fall inside the clip's source window, with their pixel position. */
function visibleKeys(
  clip: Clip,
  pxPerMs: number,
): { key: Keyframe; index: number; x: number; rate: number }[] {
  if (!hasVelocity(clip)) return [];
  const span = clip.sourceOutMs - clip.sourceInMs;
  const out: { key: Keyframe; index: number; x: number; rate: number }[] = [];
  clip.velocity.forEach((key, index) => {
    // Keys pushed outside the window by a trim still shape the curve, but they
    // have no place on the clip: drawing one would put a handle on a moment the
    // clip does not play.
    if (key.t < 0 || key.t > span) return;
    out.push({
      key,
      index,
      x: timelineAtSourceOffset(clip, key.t) * pxPerMs,
      rate: rateAt(clip, key.t),
    });
  });
  return out;
}

interface DragState {
  /** Index into `clip.velocity`, or null for the flat-speed line. */
  index: number | null;
  /** The curve as it was when the drag began, so a horizontal move stays stable. */
  keys: Keyframe[];
  /** Source offset of the dragged key at pointer-down, and the pointer's x then. */
  sourceMs: number;
  startX: number;
  /** Map from the clip as it was at pointer-down, so the x axis does not squirm. */
  atStart: Clip;
}

export function ClipVelocityLine({
  clip,
  width,
  pxPerMs,
  coarse,
}: {
  clip: Clip;
  width: number;
  pxPerMs: number;
  coarse: boolean;
}) {
  const { t } = useTranslation();
  const trackHeight = useStore((s) => s.trackHeightPx);
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  // The clip is inset by 1 (top and bottom) inside its row.
  const height = Math.max(12, trackHeight - 8);
  const ramped = hasVelocity(clip);
  const speedSet = ramped || Math.abs(clip.speed - 1) > 0.001;
  const keys = visibleKeys(clip, pxPerMs);

  /** Rate under a pointer, snapped to the detents unless Alt asks for fine control. */
  const rateAtPointer = (e: ReactPointerEvent, fine: boolean): number => {
    const box = (e.currentTarget as Element).closest('[data-clip-body]')!.getBoundingClientRect();
    const raw = topPxToRate(e.clientY - box.top, height);
    return clampRate(fine ? raw : snapRate(raw));
  };

  /** Write the ramp (or the flat speed) without a history entry: a live drag. */
  const write = (next: Keyframe[] | null, speed?: number) => {
    const patch = next ? { velocity: next } : speed !== undefined ? { speed } : null;
    if (patch) useStore.getState().updateClip(clip.id, patch);
  };

  const commit = (next: Keyframe[] | null, speed?: number) => {
    const patch = next ? { velocity: next } : speed !== undefined ? { speed } : null;
    if (patch) useStore.getState().updateClipCommitted(clip.id, patch);
  };

  const onPointerDown = (e: ReactPointerEvent, index: number | null) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = {
      index,
      keys: clip.velocity ? clip.velocity.map((k) => ({ ...k })) : [],
      sourceMs: index === null ? 0 : (clip.velocity?.[index]?.t ?? 0),
      startX: e.clientX,
      atStart: clip,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const rate = rateAtPointer(e, e.altKey);
    if (state.index === null) {
      // The flat line: the whole clip's speed, exactly like dragging the volume
      // line sets the whole clip's gain.
      write(null, rate);
      return;
    }
    // Horizontal: convert the pointer's travel through the map as it was when
    // the drag began. Using the live map would feed the curve back into the axis
    // it is drawn on, and the point would chase the pointer.
    const dxMs = (e.clientX - state.startX) / pxPerMs;
    const startTimeline = timelineAtSourceOffset(state.atStart as never, state.sourceMs);
    const span = clip.sourceOutMs - clip.sourceInMs;
    const wantedSource = sourceOffsetAtTimeline(state.atStart as never, startTimeline + dxMs);
    const before = state.keys[state.index - 1]?.t ?? -Infinity;
    const after = state.keys[state.index + 1]?.t ?? Infinity;
    const tMs = Math.min(
      Math.min(after - 1, span),
      Math.max(Math.max(before + 1, 0), wantedSource),
    );
    const next = state.keys.map((k) => ({ ...k }));
    next[state.index] = { ...next[state.index]!, t: tMs, value: rate / clip.speed };
    next.sort((a, b) => a.t - b.t);
    write(next);
  };

  const endDrag = () => {
    if (!drag.current) return;
    const state = drag.current;
    drag.current = null;
    setDragging(false);
    // The live writes already hold the final values; committing the clip as it
    // stands is what turns the whole drag into one undo step.
    const current = useStore.getState().project;
    const found = current.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clip.id);
    if (!found) return;
    if (state.index === null) commit(null, found.speed);
    else if (found.velocity) commit(found.velocity);
  };

  /** Add a point where the line was double-clicked, at the rate it already has there. */
  const addPointAt = (e: ReactPointerEvent | React.MouseEvent) => {
    if (!ramped) return;
    const box = (e.currentTarget as Element).closest('[data-clip-body]')!.getBoundingClientRect();
    const localMs = (e.clientX - box.left) / pxPerMs;
    const sourceMs = sourceOffsetAtTimeline(clip as never, localMs);
    const rate = clipRateAt(clip, clip.timelineStartMs + localMs);
    commit(setKeyframe(clip.velocity!, sourceMs, rate / clip.speed) as Keyframe[]);
  };

  /** Nudge a point by one detent, so the ramp is editable from the keyboard. */
  const onPointKey = (e: React.KeyboardEvent, index: number) => {
    const key = clip.velocity?.[index];
    if (!key) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = removeKeyframe(clip.velocity!, key.t);
      commit(Array.isArray(next) ? next : null, Array.isArray(next) ? undefined : clip.speed);
      return;
    }
    const step = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    // One twelfth of an octave with Shift, a quarter without: the coarse step
    // walks the round rates, the fine one gets between them.
    const octave = e.shiftKey ? 1 / 12 : 1 / 4;
    const rate = clampRate(rateAt(clip as never, key.t) * 2 ** (octave * step));
    commit(setKeyframe(clip.velocity!, key.t, rate / clip.speed) as Keyframe[]);
  };

  /**
   * Locked and overrun: the stretch at the end where the source has run out and
   * the last frame is held. This is the one loss with a place on the timeline -
   * source the ramp never REACHES has none (every second of the clip still
   * plays something), and the inspector says that in words instead.
   */
  const frozenPx = ramped ? Math.min(width, frozenTailMs(clip as never) * pxPerMs) : 0;

  const visibility = speedSet || dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';
  const grabPx = coarse ? GRAB_COARSE_PX : GRAB_FINE_PX;
  const flatTop = rateToTopPx(clip.speed, height);
  // The flat line takes a drag on a fine pointer only, like the volume line.
  // On touch the band sat across the middle of every selected clip and took
  // the thumb that meant to move it; the inspector's speed row is the touch
  // control, and the line stays a read-out.
  const editable = !coarse;
  /**
   * Ramp points are shaped here on a fine pointer only. A thumb needs a 44 px
   * target, and a 44 px target centred on a line inside a 28 px clip is cut in
   * half by the clip's `overflow-hidden` - a control that looks present and is
   * not reachable. On touch the line stays a read-out and the graph in the
   * inspector (`RampEditor`) is the editor, at a size that fits a thumb.
   */
  const pointsEditable = !coarse;

  return (
    <>
      {frozenPx > 1 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-10 border-l bg-black/45"
          style={{ width: frozenPx, borderColor: CLIP_COLORS.velocityRamp }}
          aria-hidden
        />
      )}

      {/* The 1x reference, dashed like the volume line's unity tick. */}
      <div
        className={`pointer-events-none absolute inset-x-0 z-10 h-0 border-t border-dashed transition-opacity ${visibility}`}
        style={{ top: rateToTopPx(1, height), borderColor: CLIP_COLORS.velocityUnity }}
        aria-hidden
      />

      {ramped ? (
        <svg
          className={`pointer-events-none absolute inset-0 z-10 h-full w-full transition-opacity ${visibility}`}
          viewBox={`0 0 ${Math.max(1, width)} ${height}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d={curvePath(clip, width, height)}
            fill="none"
            stroke={CLIP_COLORS.velocityRamp}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div
          className={`pointer-events-none absolute inset-x-0 z-10 h-0 border-t-2 transition-opacity ${visibility}`}
          style={{ top: flatTop, borderColor: CLIP_COLORS.velocityRamp }}
          aria-hidden
        />
      )}

      {/* The flat line's grab band. A ramped clip is edited by its points. */}
      {!ramped && editable && (
        <Tooltip label={t('clip.velocityLine')}>
          <div
            className="absolute inset-x-0 z-20 cursor-ns-resize touch-none"
            style={{ height: grabPx, top: flatTop - grabPx / 2 }}
            onPointerDown={(e) => onPointerDown(e, null)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={(e) => {
              e.stopPropagation();
              commit(null, 1);
            }}
            aria-label={t('clip.velocityLine')}
          />
        </Tooltip>
      )}

      {ramped &&
        pointsEditable &&
        keys.map(({ key, index, x, rate }) => (
          <button
            key={`${index}:${key.t}`}
            type="button"
            className="absolute z-30 flex touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
            style={{
              width: POINT_PX,
              height: POINT_PX,
              // Clamped into the clip: the first and last point sit exactly on
              // its edges, and the clip hides its overflow - centred, half of
              // each would be cut away and half of its target with it.
              left: Math.min(Math.max(0, x - POINT_PX / 2), Math.max(0, width - POINT_PX)),
              top: rateToTopPx(rate, height) - POINT_PX / 2,
              cursor: 'ns-resize',
            }}
            onPointerDown={(e) => onPointerDown(e, index)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={(e) => onPointKey(e, index)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const next = removeKeyframe(clip.velocity!, key.t);
              commit(Array.isArray(next) ? next : null, Array.isArray(next) ? undefined : clip.speed);
            }}
            aria-label={t('clip.velocity.point', { rate: speedX(rate) })}
          >
            <KeyframeIcon shape={keyShape(key)} className="pointer-events-none h-3 w-3" />
          </button>
        ))}

      {/* Double-click anywhere on a ramped clip's line to drop a point. The band
          spans the clip rather than tracking the curve: chasing a curve with the
          pointer to add a point to it is a game, not an affordance. */}
      {ramped && pointsEditable && (
        <div
          className="absolute inset-x-0 z-10 touch-none"
          style={{ top: LINE_INSET_PX, bottom: LINE_INSET_PX }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            addPointAt(e);
          }}
          aria-hidden
        />
      )}
    </>
  );
}
