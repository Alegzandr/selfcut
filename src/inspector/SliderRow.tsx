import { useStore } from '../store/store';

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { beginGesture, endGesture } = useStore.getState();
  return (
    <label className="flex items-center gap-3 text-xs text-zinc-400">
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
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-16 flex-none text-right font-mono tabular-nums text-zinc-300">
        {format(value)}
      </span>
    </label>
  );
}
