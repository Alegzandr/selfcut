import { useState } from 'react';
import type { MouseEvent } from 'react';
import { ComponentInstanceIcon } from '@radix-ui/react-icons';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/store';
import { decimalsForStep, seedDecimals } from './entryDecimals';

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

/**
 * How the read-out turns into a typed number when it is clicked. The number the
 * user reads is rarely the number the row stores — a 0..1 fraction reads as a
 * percentage, a millisecond duration reads as seconds, an audio fader position
 * reads as dB — so each row declares that mapping here. Both halves default to
 * the identity, which is right for a row whose read-out is already the raw
 * value (degrees, a polygon's side count).
 */
export interface NumericEntry {
  /** Stored value → the number the field is seeded with. */
  toInput?: (v: number) => number;
  /** Typed number → stored value. The row clamps the result to [min, max]. */
  fromInput?: (n: number) => number;
  /**
   * Decimals kept when seeding, fixed. Omit to let the row work them out: one
   * `step` worth, widened until the seeded text round-trips the stored value.
   */
  decimals?: number;
  /**
   * Where a typed value goes when the row's own `onChange` would coarsen it —
   * the volume fader snaps a drag to whole dB, which is precisely what typing is
   * there to escape. Defaults to `onChange`.
   */
  onCommit?: (v: number) => void;
}

/**
 * Entry for a row whose read-out is the stored value times a constant: 100 for a
 * fraction shown as a percentage, 1/1000 for milliseconds shown as seconds.
 */
export const scaledEntry = (factor: number, decimals?: number): NumericEntry => ({
  toInput: (v) => v * factor,
  fromInput: (n) => n / factor,
  decimals,
});

/** The common case: a 0..1 fraction typed as a whole percentage. */
export const PERCENT_ENTRY = scaledEntry(100);

/** Milliseconds typed as seconds. */
export const SECONDS_ENTRY = scaledEntry(1 / 1000);

const IDENTITY = (n: number) => n;

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
  entry,
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
  /**
   * Unit the read-out is typed in when clicked. Omit only when the stored value
   * is what the read-out already shows — never to opt out, since every row is
   * meant to accept an exact value instead of a hunted drag.
   */
  entry?: NumericEntry;
}) {
  const { t } = useTranslation();
  const { beginGesture, endGesture } = useStore.getState();
  // Non-null while the read-out is being typed into. Held as text, not a number,
  // so a half-typed "-" or "1." survives the keystroke that produced it.
  const [draft, setDraft] = useState<string | null>(null);

  const toInput = entry?.toInput ?? IDENTITY;
  const fromInput = entry?.fromInput ?? IDENTITY;
  // A row that declares its own precision keeps it (dB reads as one decimal,
  // period). Everywhere else the step is only a floor: see `seedDecimals`.
  const decimals =
    entry?.decimals ?? seedDecimals(toInput(value), decimalsForStep(toInput, value, step));

  const commit = () => {
    // Comma is the decimal separator on most of the locales we ship.
    const typed = parseFloat((draft ?? '').replace(',', '.'));
    setDraft(null);
    if (!isFinite(typed)) return;
    // One undo entry, exactly like a drag: the handler behind `onChange` may
    // touch several fields (a keyframe plus its channel) for a single edit.
    beginGesture();
    (entry?.onCommit ?? onChange)(Math.min(max, Math.max(min, fromInput(typed))));
    endGesture();
  };

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
              ? 'text-brand-400'
              : keyframe.animated
                ? 'text-brand-400/50 hover:text-brand-400'
                : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {/* Radix glyphs carry their own fill, so `onKey` cannot be shown by
              flipping the diamond solid the way the outlined Lucide one was.
              The button colour above already carries that state. */}
          <ComponentInstanceIcon className="h-3 w-3" />
        </button>
      )}
      {/* `min-w-0`: without it the row keeps its `min-width: auto` floor, which
          is the sum of the two 64px columns plus the range input's intrinsic
          129px. That floor is wider than the inspector, so the panel's
          `overflow-x-hidden` was quietly cutting the value column off - "0,0 dB"
          rendered as "0,0 d". The slider itself already carries `min-w-0`, so
          once the row can shrink it is the slider that gives up the space. */}
      <label className="flex min-w-0 flex-1 items-center gap-3 text-xs text-zinc-400" title={hint}>
        <span className="w-16 flex-none">{label}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          // `color-scheme: dark` is what keeps the *unfilled* half of the track
          // dark: without it the browser paints its light-theme groove, which a
          // near-white accent would be invisible against.
          className="min-w-0 flex-1 accent-zinc-300 pointer-coarse:h-8 [color-scheme:dark]"
          onPointerDown={beginGesture}
          onPointerUp={endGesture}
          onContextMenu={onContextMenu}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
      {/* The read-out sits outside the label on purpose: as a second control it
          would otherwise compete with the slider for the label's click, and a
          field nested in another control's label reads wrong to a screen reader.
          `ml-1` makes up the 12px the label's own gap used to provide. */}
      {draft === null ? (
        <button
          type="button"
          onClick={() => setDraft(toInput(value).toFixed(decimals))}
          title={t('inspector.entry.hint')}
          className="touch-hit ml-1 w-16 flex-none rounded text-right font-mono text-xs tabular-nums text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {format(value)}
        </button>
      ) : (
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          value={draft}
          aria-label={t('inspector.entry.label', { label })}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
            // The editor's shortcuts listen on the window: J, K, S and friends
            // are keystrokes here, not transport commands.
            e.stopPropagation();
          }}
          className="ml-1 w-16 flex-none rounded border border-brand-500 bg-zinc-800 px-1 text-right font-mono text-xs tabular-nums text-zinc-100 outline-none"
        />
      )}
    </div>
  );
}
