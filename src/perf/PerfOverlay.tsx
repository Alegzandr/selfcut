import { useEffect, useState, useSyncExternalStore } from 'react';
import { isHudOpen, setHudOpen, subscribeHud, toggleHud } from './hud';
import { subscribePerf, type PerfSnapshot } from './probe';

/**
 * The performance HUD.
 *
 * The point of this panel is that "the preview feels slow" stops being an
 * opinion. It shows where a frame's time actually goes - decode wait, colour
 * grade, mask, blit, scopes - together with the frames the renderer could not
 * keep up with, which is the number that corresponds to what the eye sees.
 *
 * It reads a snapshot pushed a few times a second, never per frame: a HUD that
 * re-rendered on every measurement would be the largest thing in its own
 * measurements.
 *
 * Toggle with Ctrl+Alt+P.
 */
export function PerfOverlay() {
  const open = useSyncExternalStore(subscribeHud, isHudOpen, () => false);
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        toggleHud();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      setSnap(null);
      return;
    }
    return subscribePerf(setSnap);
  }, [open]);

  if (!open) return null;

  const frame = snap?.timings.find((t) => t.name === 'frame');
  const fps = frame && frame.mean > 0 ? Math.min(999, 1000 / Math.max(frame.mean, 1 / 999)) : null;
  const overPct = snap && snap.frames > 0 ? (snap.overBudget / snap.frames) * 100 : 0;

  return (
    <div
      className="pointer-events-auto absolute right-2 top-2 z-30 w-60 select-none rounded border border-zinc-700 bg-zinc-900/95 p-2 text-[10px] leading-relaxed text-zinc-300 shadow-lg"
      role="status"
      aria-label="Performance"
    >
      <div className="mb-1 flex items-center justify-between border-b border-zinc-700 pb-1">
        <span className="font-semibold tracking-wider text-zinc-100">PERF</span>
        <button
          className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => setHudOpen(false)}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {!snap || snap.frames === 0 ? (
        <p className="text-zinc-500">measuring…</p>
      ) : (
        <>
          <Row
            label="loop"
            value={`${fps ? fps.toFixed(0) : '--'} fps`}
            detail={`p95 ${frame ? frame.p95.toFixed(1) : '--'} ms`}
          />
          <Row
            label="over budget"
            value={`${overPct.toFixed(0)} %`}
            detail={`of ${snap.frames} frames`}
            warn={overPct > 10}
          />
          <div className="my-1 border-t border-zinc-800" />
          {snap.timings
            .filter((t) => t.name !== 'frame' && t.mean > 0.005)
            .slice(0, 7)
            .map((t) => (
              <Row
                key={t.name}
                label={t.name}
                value={`${t.mean.toFixed(2)} ms`}
                detail={`p95 ${t.p95.toFixed(1)}`}
              />
            ))}
          <div className="my-1 border-t border-zinc-800" />
          {snap.counters
            .filter((c) => c.mean > 0)
            .slice(0, 6)
            .map((c) => (
              <Row
                key={c.name}
                label={c.name}
                value={c.mean >= 10 ? c.mean.toFixed(0) : c.mean.toFixed(1)}
                detail={`max ${c.max.toFixed(0)}`}
              />
            ))}
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  detail,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 flex-1 truncate text-zinc-500">{label}</span>
      <span className={`tabular-nums ${warn ? 'text-amber-400' : 'text-zinc-100'}`}>{value}</span>
      {detail && <span className="w-16 text-right tabular-nums text-zinc-600">{detail}</span>}
    </div>
  );
}
