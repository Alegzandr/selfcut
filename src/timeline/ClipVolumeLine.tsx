import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { UNITY_FADER, faderToLinePos } from '../lib/gain';
import type { useVolumeEntry } from '../ui/VolumeEntry';
import type { DragState } from './clipDrag';

/**
 * `bottom` for the volume line at a given fader position. The clip clips its
 * overflow, so both ends are inset far enough for the line - and above all its
 * grab band - to stay inside: at silence the handle would otherwise hang below
 * the clip, out of reach, with no way to bring the gain back up.
 *
 * Pair it with `translate-y-1/2` so the stroke is centred on the position -
 * otherwise the 2 px gain line sits a pixel above the 1 px unity tick and the
 * two never quite meet at 0 dB.
 */
const volumeLineBottom = (fader: number) =>
  `clamp(5px, ${faderToLinePos(fader) * 100}%, calc(100% - 3px))`;

/**
 * Vegas-style volume line: a horizontal gain line across the clip, dragged
 * up/down to set clip.volume. Its height IS the fader position, so the
 * gain is readable at a glance; the dashed tick marks unity (0 dB). Only
 * clips that actually carry audio get one.
 *
 * At unity the line carries no information, and drawing it on every clip
 * of every track turns the timeline into a grid of amber rules. So it
 * only stays lit when the gain is actually trimmed; otherwise it fades
 * in on hover or selection, right when it becomes draggable.
 */
export function ClipVolumeLine({
  clipId,
  volumeFader,
  gainTrimmed,
  selected,
  coarse,
  volumeEntry,
  beginDrag,
  onPointerMove,
  onPointerUp,
}: {
  clipId: string;
  volumeFader: number;
  gainTrimmed: boolean;
  selected: boolean;
  coarse: boolean;
  volumeEntry: ReturnType<typeof useVolumeEntry>;
  beginDrag: (e: ReactPointerEvent, mode: DragState['mode']) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div
        className={`pointer-events-none absolute inset-x-0 z-10 h-0 translate-y-1/2 border-t border-dashed border-white/25 transition-opacity ${gainTrimmed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${selected ? 'opacity-100' : ''}`}
        style={{ bottom: volumeLineBottom(UNITY_FADER) }}
      />
      <div
        className={`pointer-events-none absolute inset-x-0 z-10 h-0 translate-y-1/2 border-t-2 border-amber-300/90 transition-opacity ${gainTrimmed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${selected ? 'opacity-100' : ''}`}
        style={{ bottom: volumeLineBottom(volumeFader) }}
      />
      {/* Desktop only. On touch the band sat across the middle of a selected
          clip, 24px tall in a 56px lane, so the thumb that meant to move the
          clip trimmed its gain instead - and CapCut has no such line at all.
          The inspector's volume slider is the touch control. */}
      {!coarse && (
        <Tooltip label={t('clip.volumeLine')}>
          <div
            className="absolute inset-x-0 z-20 h-2 translate-y-1/2 cursor-ns-resize touch-none"
            style={{ bottom: volumeLineBottom(volumeFader) }}
            onPointerDown={(e) => beginDrag(e, 'volume')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              useStore.getState().updateClipCommitted(clipId, { volume: 1 });
            }}
            // Right on the line, the decimal entry beats the clip menu.
            onContextMenu={volumeEntry.onContextMenu}
          />
        </Tooltip>
      )}
      {volumeEntry.entry}
    </>
  );
}
