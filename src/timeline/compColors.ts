import type { MarkerColor } from '../types';

/**
 * Tailwind classes per composition colour: the clip body on the timeline, the
 * card in the library, the chip in the breadcrumb.
 *
 * A composition borrows the marker palette rather than getting one of its own -
 * a cut room already sorts by those six hues, and a seventh set would only make
 * two things that look alike mean different things. Spelled out in full so the
 * JIT sees every class it has to emit.
 */
export interface CompColorClasses {
  /** The clip's own body: a gradient dark enough to read a label over. */
  body: string;
  /** Icon and label over that body. */
  ink: string;
  /** Solid swatch: the breadcrumb chip's dot, the card's corner. */
  dot: string;
  /** Card and chip surface, a step lighter than the timeline's ground. */
  chip: string;
}

export function compColorClass(color: MarkerColor | undefined): CompColorClasses {
  switch (color ?? 'violet') {
    case 'red':
      return {
        body: 'bg-gradient-to-b from-red-900/70 to-red-950',
        ink: 'text-red-100',
        dot: 'bg-red-400',
        chip: 'border-red-400/40 bg-red-500/15 text-red-100',
      };
    case 'amber':
      return {
        body: 'bg-gradient-to-b from-amber-900/70 to-amber-950',
        ink: 'text-amber-100',
        dot: 'bg-amber-400',
        chip: 'border-amber-400/40 bg-amber-500/15 text-amber-100',
      };
    case 'green':
      return {
        body: 'bg-gradient-to-b from-emerald-900/70 to-emerald-950',
        ink: 'text-emerald-100',
        dot: 'bg-emerald-400',
        chip: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100',
      };
    case 'pink':
      return {
        body: 'bg-gradient-to-b from-pink-900/70 to-pink-950',
        ink: 'text-pink-100',
        dot: 'bg-pink-400',
        chip: 'border-pink-400/40 bg-pink-500/15 text-pink-100',
      };
    case 'cyan':
      return {
        body: 'bg-gradient-to-b from-cyan-900/70 to-cyan-950',
        ink: 'text-cyan-100',
        dot: 'bg-cyan-400',
        chip: 'border-cyan-400/40 bg-cyan-500/15 text-cyan-100',
      };
    default:
      return {
        body: 'bg-gradient-to-b from-violet-900/70 to-violet-950',
        ink: 'text-violet-100',
        dot: 'bg-violet-400',
        chip: 'border-violet-400/40 bg-violet-500/15 text-violet-100',
      };
  }
}
