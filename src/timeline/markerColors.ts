import type { MarkerColor } from '../types';

/**
 * Tailwind classes per marker colour: the flag in the marker bar, its line
 * across the tracks, and the swatch in the colour menu. Spelled out in full
 * so the JIT sees every class it has to emit.
 */
export function markerColorClass(color: MarkerColor | undefined): {
  flag: string;
  line: string;
  dot: string;
} {
  switch (color ?? 'cyan') {
    case 'red':
      return { flag: 'border-red-400 bg-red-500/25 text-red-100', line: 'bg-red-400/40', dot: 'bg-red-400' };
    case 'amber':
      return { flag: 'border-amber-400 bg-amber-500/25 text-amber-100', line: 'bg-amber-400/40', dot: 'bg-amber-400' };
    case 'green':
      return { flag: 'border-emerald-400 bg-emerald-500/25 text-emerald-100', line: 'bg-emerald-400/40', dot: 'bg-emerald-400' };
    case 'violet':
      return { flag: 'border-violet-400 bg-violet-500/25 text-violet-100', line: 'bg-violet-400/40', dot: 'bg-violet-400' };
    case 'pink':
      return { flag: 'border-pink-400 bg-pink-500/25 text-pink-100', line: 'bg-pink-400/40', dot: 'bg-pink-400' };
    default:
      return { flag: 'border-cyan-400 bg-cyan-500/25 text-cyan-100', line: 'bg-cyan-400/40', dot: 'bg-cyan-400' };
  }
}
