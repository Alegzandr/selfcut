import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MAX_DB, MIN_DB, dbToGain, gainToDb } from '../lib/gain';

/** Gap kept between the panel and the viewport edge when it has to flip/clamp. */
const EDGE_MARGIN_PX = 8;

/**
 * Right-click entry for any volume fader: the faders themselves snap to whole
 * dB, and this is where the decimals live. Same escape hatch as the numeric
 * field next to a speed preset - the coarse control stays coarse, and the exact
 * value is one click away instead of being drag-hunted.
 *
 * Returns the handler to spread on the fader plus the panel to render next to
 * it; the caller owns nothing else.
 */
export function useVolumeEntry({
  gain,
  maxDb = MAX_DB,
  onCommit,
}: {
  gain: number;
  /** Ceiling of the scale - the master monitor stops at unity. */
  maxDb?: number;
  onCommit: (gain: number) => void;
}): { onContextMenu: (e: MouseEvent) => void; entry: ReactNode } {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  return {
    onContextMenu: (e: MouseEvent) => {
      // Take the click before the surrounding clip/track menu claims it.
      e.preventDefault();
      e.stopPropagation();
      setAt({ x: e.clientX, y: e.clientY });
    },
    entry: at ? (
      <VolumeEntryPanel
        x={at.x}
        y={at.y}
        gain={gain}
        maxDb={maxDb}
        onCommit={onCommit}
        onClose={() => setAt(null)}
      />
    ) : null,
  };
}

function VolumeEntryPanel({
  x,
  y,
  gain,
  maxDb,
  onCommit,
  onClose,
}: {
  x: number;
  y: number;
  gain: number;
  maxDb: number;
  onCommit: (gain: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const db = gainToDb(gain);
  const [text, setText] = useState(isFinite(db) ? String(Math.round(db * 10) / 10) : String(MIN_DB));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place after measuring, like the context menu: flip at the viewport edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE_MARGIN_PX, Math.min(x, window.innerWidth - width - EDGE_MARGIN_PX)),
      top: Math.max(EDGE_MARGIN_PX, Math.min(y, window.innerHeight - height - EDGE_MARGIN_PX)),
    });
  }, [x, y]);

  const commit = () => {
    // Comma is the decimal separator on most of the locales we ship.
    const v = parseFloat(text.replace(',', '.'));
    if (isFinite(v)) onCommit(dbToGain(Math.min(maxDb, v)));
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[200] rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl shadow-black/50"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        // Hide the pre-measurement paint so the panel never flashes at the raw click point.
        visibility: pos ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          min={MIN_DB}
          max={maxDb}
          step={0.1}
          value={text}
          aria-label={t('volume.entry.label')}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') onClose();
            e.stopPropagation();
          }}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-right font-mono text-xs text-zinc-200 outline-none focus:border-sky-500"
        />
        <span className="text-xs text-zinc-400">dB</span>
      </div>
      <p className="mt-1.5 max-w-40 text-[10px] leading-tight text-zinc-500">
        {t('volume.entry.hint', { min: MIN_DB })}
      </p>
    </div>,
    document.body,
  );
}
