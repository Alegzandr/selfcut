import { useTranslation } from 'react-i18next';
import { useStore } from '../store/store';
import { socialChrome } from './guides';

/**
 * The monitor's guide overlay: safe margins, the thirds grid, or the chrome
 * of the platform the cut is going to. Drawn inside the stage in normalized
 * coordinates so it scales with the camera, and never composited - it is a
 * ruler laid over the picture, not part of it.
 */
export function PreviewGuidesOverlay() {
  const { t } = useTranslation();
  const mode = useStore((s) => s.previewGuides);
  const aspect = useStore((s) => s.project.aspectRatio);
  if (mode === 'off') return null;

  const line = 'stroke-white/70';
  const dashed = { strokeDasharray: '4 3' };

  return (
    <svg
      data-preview-guides={mode}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {mode === 'safe' && (
        <>
          {/* Action safe (90%) then title safe (80%), the broadcast pair. */}
          <rect x="5" y="5" width="90" height="90" fill="none" className={line} strokeWidth="0.25" vectorEffect="non-scaling-stroke" style={dashed} />
          <rect x="10" y="10" width="80" height="80" fill="none" className="stroke-amber-300/80" strokeWidth="0.25" vectorEffect="non-scaling-stroke" />
          <line x1="48" y1="50" x2="52" y2="50" className={line} strokeWidth="0.25" vectorEffect="non-scaling-stroke" />
          <line x1="50" y1="48" x2="50" y2="52" className={line} strokeWidth="0.25" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {mode === 'thirds' && (
        <>
          {[33.333, 66.667].map((v) => (
            <g key={v}>
              <line x1={v} y1="0" x2={v} y2="100" className={line} strokeWidth="0.25" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={v} x2="100" y2={v} className={line} strokeWidth="0.25" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </>
      )}
      {mode === 'social' && (
        <>
          {socialChrome(aspect).map((r, i) => (
            <rect
              key={i}
              x={r.x * 100}
              y={r.y * 100}
              width={r.w * 100}
              height={r.h * 100}
              className="fill-rose-400/20 stroke-rose-300/80"
              strokeWidth="0.25"
              vectorEffect="non-scaling-stroke"
              style={dashed}
            />
          ))}
          {/* The title-safe box stays: what is left of the frame once the app
              has painted its chrome is still framed by the same margins. */}
          <rect x="10" y="10" width="80" height="80" fill="none" className="stroke-amber-300/60" strokeWidth="0.25" vectorEffect="non-scaling-stroke" style={dashed} />
          <text
            x="50"
            y="97"
            textAnchor="middle"
            className="fill-rose-100/80"
            style={{ fontSize: aspect === '9:16' ? 1.6 : 2.4, letterSpacing: 0.1 }}
          >
            {t('preview.guides.social.caption')}
          </text>
        </>
      )}
    </svg>
  );
}
