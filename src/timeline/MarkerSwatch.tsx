import type { ComponentType } from 'react';
import type { MarkerColor } from '../types';
import { markerColorClass } from './markerColors';

const cache = new Map<MarkerColor, ComponentType<{ className?: string }>>();

/**
 * A menu icon that is a swatch of the marker colour: the colour rows of the
 * marker menu show what they set instead of naming it. Memoized per colour so
 * the menu's row keys stay stable across renders.
 */
export function markerSwatchIcon(color: MarkerColor): ComponentType<{ className?: string }> {
  let icon = cache.get(color);
  if (!icon) {
    const dot = markerColorClass(color).dot;
    icon = function MarkerSwatch({ className }: { className?: string }) {
      return (
        <span className={`flex items-center justify-center ${className ?? ''}`}>
          <span className={`block h-2.5 w-2.5 rounded-full ${dot}`} />
        </span>
      );
    };
    cache.set(color, icon);
  }
  return icon;
}
