import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { gainDb } from '../inspector/format';
import { DB_STEP_FADER, faderToGainStepped, gainToFader, UNITY_FADER } from '../lib/gain';
import { useVolumeEntry } from './VolumeEntry';

/**
 * Master monitoring level of the preview, pinned to the right of the menu bar.
 *
 * A listening control, not an edit: it scales the preview's master bus only, so
 * it stays out of the undo history and the export renders at full level whatever
 * this fader says. Unity sits at the top of the travel - a monitor never boosts,
 * it would only clip what the meters show as clean.
 */
export function MasterVolume() {
  const { t } = useTranslation();
  const volume = useStore((s) => s.previewVolume);
  const muted = useStore((s) => s.previewMuted);
  const setPreviewVolume = useStore((s) => s.setPreviewVolume);
  const togglePreviewMuted = useStore((s) => s.togglePreviewMuted);
  // The dB read-out only surfaces on hover/drag: a permanent number in the menu
  // bar is noise, but the width is reserved so nothing shifts when it appears.
  const [active, setActive] = useState(false);
  // Unity is the ceiling here too: the entry cannot boost past what the fader can.
  const volumeEntry = useVolumeEntry({ gain: volume, maxDb: 0, onCommit: setPreviewVolume });

  const Icon = muted || volume <= 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const label = muted ? t('master.unmute') : t('master.mute');

  return (
    <div
      className="flex items-center gap-1.5 pl-2"
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
    >
      <span
        className={`w-14 select-none text-right font-mono text-[10px] tabular-nums text-zinc-500 transition-opacity ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden
      >
        {gainDb(volume)}
      </span>

      <Tooltip label={label} placement="bottom">
        <button
          type="button"
          className={`flex h-5 w-5 items-center justify-center rounded hover:bg-zinc-800/60 ${
            muted ? 'text-red-400' : 'text-zinc-400'
          }`}
          onClick={togglePreviewMuted}
          aria-pressed={muted}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </Tooltip>

      <input
        type="range"
        min={0}
        max={UNITY_FADER}
        step={DB_STEP_FADER}
        value={gainToFader(volume)}
        className={`slider-thin w-24 cursor-ew-resize ${muted ? 'text-zinc-600' : 'text-sky-500'}`}
        aria-label={t('master.volume', { db: gainDb(volume) })}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        onChange={(e) => setPreviewVolume(faderToGainStepped(Number(e.target.value)))}
        onDoubleClick={() => setPreviewVolume(1)}
        onContextMenu={volumeEntry.onContextMenu}
      />
      {volumeEntry.entry}
    </div>
  );
}
