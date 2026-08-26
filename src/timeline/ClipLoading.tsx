import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isVisualJobActive, subscribeVisualJobs } from '../media/visualJobs';

/** Whether a background visuals pass is running for this key right now. */
export function useVisualJob(key: string | null): boolean {
  return useSyncExternalStore(
    subscribeVisualJobs,
    () => (key ? isVisualJobActive(key) : false),
    () => false,
  );
}

interface Props {
  /** Colour family of the lane it sits in: audio clips are emerald, video brand blue. */
  tone: 'emerald' | 'brand';
  /** What is being read, already translated by the caller's namespace. */
  label: string;
  /** On-screen width of the clip, to drop the label when there is no room. */
  widthPx: number;
}

/** Below this the label is more clutter than information; the drift still shows. */
const LABEL_MIN_PX = 110;

/**
 * Period of the drifting highlight, in px, and the tint it is drawn in.
 *
 * A repeating gradient rather than one travelling band: a clip can be six
 * pixels wide or six thousand, and a band sized as a fraction of it would be
 * either a flicker or a wash that never visibly moves. A fixed period reads the
 * same at every zoom. `--animate-clip-scan` shifts by exactly one period.
 */
const SCAN_PERIOD_PX = 320;
const TINT = {
  emerald: 'rgb(110 231 183 / 0.16)',
  brand: 'rgb(125 206 247 / 0.16)',
} as const;

/**
 * A clip whose waveform or filmstrip has not arrived yet.
 *
 * Informative, never blocking: the clip is already there and fully editable
 * (trim it, move it, play it) while this runs. So it reads as an empty lane
 * being filled rather than as a barrier: a slow highlight passing along the
 * lane in the direction the pass is reading, and a word for what is being
 * read. No spinner: a rotating thing on a timeline lane says "wait", which
 * is exactly what the user must not do here. No flat centre line either: the
 * volume line already sits there, and a second horizontal rule at the same
 * height reads as a control rather than as a state.
 *
 * The sweep is decoration and is dropped under `prefers-reduced-motion`; the
 * label and its pulse carry the same information on their own.
 */
export function ClipLoading({ tone, label, widthPx }: Props) {
  const { t } = useTranslation();
  const dot = tone === 'emerald' ? 'bg-emerald-300' : 'bg-brand-300';
  const text = tone === 'emerald' ? 'text-emerald-100/80' : 'text-brand-100/80';

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      // Announced once rather than on every change: this is a status, and the
      // clip's own name is already what identifies it.
      role="status"
      aria-label={t('timeline.clip.loadingAria', { what: label })}
    >
      <div
        className="absolute inset-y-0 left-0 animate-clip-scan motion-reduce:hidden"
        style={{
          width: `calc(100% + ${SCAN_PERIOD_PX}px)`,
          backgroundImage: `repeating-linear-gradient(90deg, transparent 0 ${SCAN_PERIOD_PX * 0.3}px, ${TINT[tone]} ${SCAN_PERIOD_PX / 2}px, transparent ${SCAN_PERIOD_PX * 0.7}px ${SCAN_PERIOD_PX}px)`,
        }}
      />
      {widthPx >= LABEL_MIN_PX && (
        <div className="absolute bottom-0.5 left-1.5 flex items-center gap-1">
          <span className={`h-1 w-1 animate-pulse rounded-full ${dot}`} />
          <span className={`text-4xs ${text}`}>{label}</span>
        </div>
      )}
    </div>
  );
}
