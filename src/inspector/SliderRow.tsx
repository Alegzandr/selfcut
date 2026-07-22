import type { MouseEvent } from 'react';
import { Diamond } from 'lucide-react';
import { useStore } from '../store/store';

/**
 * Keyframe control for a slider row: the diamond that turns the property into an
 * animated channel and toggles a key at the playhead. `animated` highlights the
 * diamond while the property has keyframes; `onKey` fills it when one sits on the
 * playhead. Absent = the row has no keyframe affordance.
 */
export interface KeyframeControl {
  animated: boolean;
  onKey: boolean;
  onToggle: () => void;
  /** Accessible label for the diamond button (already includes the property). */
  label: string;
}

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
  keyframe,
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
  /** Keyframe affordance; omit for a plain, non-animatable slider. */
  keyframe?: KeyframeControl;
}) {
  const { beginGesture, endGesture } = useStore.getState();
  return (
    <div className="flex items-center gap-2">
      {keyframe && (
        <button
          type="button"
          onClick={keyframe.onToggle}
          aria-label={keyframe.label}
          aria-pressed={keyframe.animated}
          title={keyframe.label}
          className={`touch-hit flex-none rounded p-0.5 ${
            keyframe.onKey
              ? 'text-sky-400'
              : keyframe.animated
                ? 'text-sky-400/50 hover:text-sky-400'
                : 'text-zinc-600 hover:text-zinc-400'
          }`}
        >
          <Diamond className="h-3 w-3" fill={keyframe.onKey ? 'currentColor' : 'none'} />
        </button>
      )}
      <label className="flex flex-1 items-center gap-3 text-xs text-zinc-400" title={hint}>
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
    </div>
  );
}
