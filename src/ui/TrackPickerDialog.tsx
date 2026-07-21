import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, X } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { JobProgress } from './JobProgress';
import type { FFmpegProgress } from '../media/ffmpeg';

/** Above this many rows, scanning the list by eye stops working: offer a filter. */
const FILTER_ABOVE = 8;

export interface PickerTrack {
  /** Position among tracks of this kind, which is also what ffmpeg's `0:s:<n>` selects. */
  index: number;
  name: string;
  /** Short format tag shown beside the name ('ASS', 'E-AC-3'…). */
  detail: string;
  /**
   * Why this track cannot be brought in (picture-based subtitles, say). Set, the
   * row explains itself instead of offering a button: these are real tracks the
   * user can see in any player, and hiding them would read as a failed detection.
   */
  unavailable?: string;
  /** Present while a job for this track is running. */
  progress?: FFmpegProgress;
}

/**
 * Pick one track out of a source's list, in a dialog rather than in the card.
 *
 * The media library column is ~150 px wide, and a disc rip carries twenty-odd
 * subtitle tracks: no amount of folding or truncating makes that list readable
 * in place, and the names are exactly what the choice turns on ('English SDH'
 * against 'English Dubtitle'). So the card keeps a one-line summary and hands
 * the actual choosing to a surface with room for it.
 *
 * Generic over what is being picked: subtitles today, and the same shape fits
 * any other on-demand stream import.
 */
export function TrackPickerDialog({
  open,
  title,
  hint,
  tracks,
  actionLabel,
  actionHint,
  icon,
  onPick,
  onCancelJob,
  onClose,
}: {
  open: boolean;
  title: string;
  hint?: string;
  tracks: PickerTrack[];
  actionLabel: string;
  actionHint: string;
  icon: React.ReactNode;
  onPick: (index: number) => void;
  onCancelJob: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  // Escape closes; capture phase so the global editor hotkeys never see it while
  // the dialog owns the screen.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A stale filter must not greet the next opening with an empty list.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) =>
      `${track.name} ${track.detail}`.toLowerCase().includes(needle),
    );
  }, [tracks, query]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="flex max-h-[75vh] w-full max-w-md flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <h2 className="min-w-0 text-sm font-semibold text-zinc-100">{title}</h2>
              <Tooltip label={t('library.tracks.close')} shortcut="Esc">
                <button
                  className="-mt-1 flex-none rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
                  onClick={onClose}
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            {hint && <p className="text-xs leading-relaxed text-zinc-400">{hint}</p>}

            {tracks.length > FILTER_ABOVE && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5">
                <Search className="h-3.5 w-3.5 flex-none text-zinc-500" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                  placeholder={t('library.tracks.filter')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t('library.tracks.filter')}
                />
              </div>
            )}

            <div className="-mr-2 mt-3 min-h-0 flex-1 overflow-y-auto pr-2">
              {shown.length === 0 ? (
                <p className="py-6 text-center text-xs text-zinc-500">
                  {t('library.tracks.noMatch')}
                </p>
              ) : (
                <ul className="divide-y divide-zinc-800">
                  {shown.map((track) => (
                    <li key={track.index} className="py-2">
                      {track.progress ? (
                        <JobProgress
                          progress={track.progress}
                          name={track.name}
                          dense={false}
                          onCancel={() => onCancelJob(track.index)}
                        />
                      ) : (
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs text-zinc-200">{track.name}</div>
                            <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                              {track.unavailable
                                ? `${track.detail} · ${track.unavailable}`
                                : track.detail}
                            </div>
                          </div>
                          {!track.unavailable && (
                            <Tooltip label={actionHint}>
                              <button
                                className="touch-hit flex-none rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/25 active:bg-sky-500/30"
                                onClick={() => onPick(track.index)}
                              >
                                {icon}
                                {actionLabel}
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
