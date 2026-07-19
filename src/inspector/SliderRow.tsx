import type { MouseEvent } from 'react';
import { useStore } from '../store/store';

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  hint,
  onChange,
  onContextMenu,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** Native tooltip, for a control whose label cannot carry the whole meaning. */
  hint?: string;
  onChange: (v: number) => void;
  /** Right-click on the track itself, for a control that offers a finer entry. */
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const { beginGesture, endGesture } = useStore.getState();
  return (
    <label className="flex items-center gap-3 text-xs text-zinc-400" title={hint}>
      <span className="w-16 flex-none">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        className="min-w-0 flex-1 accent-sky-500 pointer-coarse:h-8"
        onPointerDown={beginGesture}
        onPointerUp={endGesture}
        onContextMenu={onContextMenu}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-16 flex-none text-right font-mono tabular-nums text-zinc-300">
        {format(value)}
      </span>
    </label>
  );
}
