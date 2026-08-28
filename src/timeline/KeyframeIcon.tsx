/**
 * The shape a keyframe is drawn as, on every timeline lane.
 *
 * The glyph is not decoration: it spells the interpolation of the segment
 * leaving the key, the way every NLE does it. A square steps (hold), a diamond
 * runs straight (linear), a circle curves (the eased presets and any custom
 * Bezier from the graph editor). A lane's motion is then readable at a glance,
 * with no click and no inspector round-trip.
 *
 * One `<svg>` per diamond rather than a rotated bordered `<div>`: a square and a
 * circle cannot both come out of the same box, and the glyph has to be able to
 * change under the pointer without the element remounting mid-drag.
 */
import type { KeyShape } from '../model';

/** Fill/stroke of the glyph. Selection is a colour, the shape stays the shape. */
export type KeyframeTone = 'idle' | 'selected';

const TONE: Record<KeyframeTone, string> = {
  idle: 'fill-zinc-100 stroke-zinc-900 group-hover:fill-blue-200 group-active:fill-blue-300',
  selected: 'fill-blue-400 stroke-blue-200',
};

export function KeyframeIcon({
  shape,
  tone = 'idle',
  className = '',
}: {
  shape: KeyShape;
  tone?: KeyframeTone;
  className?: string;
}) {
  return (
    // A 12-unit box with the glyph inset by 1: the stroke then sits inside the
    // viewBox instead of being clipped on all four sides.
    <svg viewBox="0 0 12 12" className={className} aria-hidden focusable="false">
      <g className={TONE[tone]} strokeWidth={1.2} vectorEffect="non-scaling-stroke">
        {shape === 'square' ? (
          <rect x={1.5} y={1.5} width={9} height={9} rx={1} />
        ) : shape === 'round' ? (
          <circle cx={6} cy={6} r={4.5} />
        ) : (
          <polygon points="6,1 11,6 6,11 1,6" />
        )}
      </g>
    </svg>
  );
}

/**
 * The graph-editor glyph: an S-curve rising between two control dots. Radix has
 * no Bezier icon, and a generic slider or activity glyph would read as "levels"
 * rather than "interpolation" - the one thing this button is about.
 */
export function CurveIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 15 15" className={className} aria-hidden focusable="false">
      <path
        d="M1.5 13C6 13 4 2 13.5 2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
      />
      <circle cx={1.5} cy={13} r={1.6} fill="currentColor" />
      <circle cx={13.5} cy={2} r={1.6} fill="currentColor" />
    </svg>
  );
}
