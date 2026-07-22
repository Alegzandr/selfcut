import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeLevels } from '../preview/meterBus';
import { Tooltip } from '../ui/Tooltip';
import { METER_COLORS } from '../lib/palette';

/** Meter floor: -48 dBFS maps to an empty bar, 0 dBFS to a full one. */
const MIN_DB = -48;

/**
 * Live level meter of one track, fed by the playback engine through the
 * meter bus. DOM is updated directly (no React state): levels change every
 * animation frame during playback.
 */
export function TrackMeter({ trackId }: { trackId: string }) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);
  const clipDotRef = useRef<HTMLDivElement>(null);
  const clipUntil = useRef(0);

  useEffect(() => {
    let displayed = 0;
    return subscribeLevels((levels) => {
      const peak = levels[trackId];
      // Fast attack, slow release; an empty publish (stop) drops to silence.
      displayed = peak === undefined ? 0 : peak > displayed ? peak : displayed * 0.85;
      const db = displayed > 0 ? 20 * Math.log10(displayed) : -Infinity;
      const frac = Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB));
      const bar = barRef.current;
      if (bar) {
        bar.style.width = `${frac * 100}%`;
        bar.style.backgroundColor =
          db > -3 ? METER_COLORS.hot : db > -12 ? METER_COLORS.warm : METER_COLORS.normal;
      }
      if ((peak ?? 0) >= 1) clipUntil.current = performance.now() + 1000;
      const dot = clipDotRef.current;
      if (dot) dot.style.opacity = performance.now() < clipUntil.current ? '1' : '0.15';
    });
  }, [trackId]);

  return (
    <Tooltip label={t('track.meter.title')}>
      <div className="flex h-1.5 w-full items-center gap-0.5">
        <div className="h-full min-w-0 flex-1 overflow-hidden rounded-sm bg-zinc-800">
          <div ref={barRef} className="h-full w-0 rounded-sm" />
        </div>
        <div ref={clipDotRef} className="h-1.5 w-1.5 flex-none rounded-full bg-red-500 opacity-15" />
      </div>
    </Tooltip>
  );
}
