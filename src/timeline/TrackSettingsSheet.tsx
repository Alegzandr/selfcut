import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { useEnterMotion } from '../ui/motion';
import { BlendingModeIcon, Cross2Icon, SpeakerLoudIcon } from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { gainDb } from '../inspector/format';
import { faderToGainStepped, gainToFader } from '../lib/gain';

/**
 * The track's levels, on touch.
 *
 * The desktop header carries these two faders inline; the touch header is 44px
 * wide and carries two icon buttons, so until this sheet existed a phone could
 * mute a track but never set its volume or its opacity - the only feature of
 * the editor with no touch path left once the menus were reachable.
 *
 * Opened from the track menu ("…" on the header) and scoped to one track, so it
 * does not need a selection to exist: a track is not a clip.
 */
export function TrackSettingsSheet() {
  const { t } = useTranslation();
  const sheet = useEnterMotion({ y: '100%' });
  const trackId = useStore((s) => s.trackSettingsTrackId);
  const track = useStore((s) => s.project.tracks.find((tr) => tr.id === trackId) ?? null);
  const { setTrackSettingsTrack, updateTrack, beginGesture, endGesture } = useStore.getState();
  const close = () => setTrackSettingsTrack(null);

  // A deleted track must not leave its sheet up over an empty timeline.
  const open = track !== null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/60"
            onClick={close}
          />
          <m.div
            {...sheet}
            transition={{ type: 'spring', damping: 32, stiffness: 380 }}
            role="dialog"
            aria-modal="true"
            aria-label={t('track.settings')}
            className="fixed inset-x-0 bottom-0 z-[60] rounded-t-2xl border-t border-zinc-700 bg-zinc-900 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black"
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <span className="text-xs font-semibold text-zinc-200">{t('track.settings')}</span>
              <button
                type="button"
                className="touch-hit ml-auto rounded-lg p-2 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
                onClick={close}
                aria-label={t('mobile.menu.close')}
              >
                <Cross2Icon className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-4 py-4">
              <label className="flex items-center gap-3">
                <SpeakerLoudIcon className="h-4 w-4 flex-none text-zinc-500" aria-hidden />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={gainToFader(track.volume ?? 1)}
                  className="min-w-0 flex-1 accent-zinc-300 pointer-coarse:h-8 [color-scheme:dark]"
                  aria-label={t('a11y.track.volume')}
                  aria-valuetext={gainDb(track.volume ?? 1)}
                  // One undo step per gesture, like the desktop fader.
                  onPointerDown={beginGesture}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                  onChange={(e) =>
                    updateTrack(track.id, { volume: faderToGainStepped(Number(e.target.value)) })
                  }
                />
                <span className="w-14 flex-none text-right text-2xs tabular-nums text-zinc-400">
                  {gainDb(track.volume ?? 1)}
                </span>
              </label>

              {track.kind === 'video' && (
                <label className="flex items-center gap-3">
                  <BlendingModeIcon className="h-4 w-4 flex-none text-zinc-500" aria-hidden />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={track.opacity ?? 1}
                    className="min-w-0 flex-1 accent-zinc-300 pointer-coarse:h-8 [color-scheme:dark]"
                    aria-label={t('a11y.track.opacity')}
                    aria-valuetext={`${Math.round((track.opacity ?? 1) * 100)}%`}
                    onPointerDown={beginGesture}
                    onPointerUp={endGesture}
                    onPointerCancel={endGesture}
                    onChange={(e) => updateTrack(track.id, { opacity: Number(e.target.value) })}
                  />
                  <span className="w-14 flex-none text-right text-2xs tabular-nums text-zinc-400">
                    {Math.round((track.opacity ?? 1) * 100)} %
                  </span>
                </label>
              )}
            </div>
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}
