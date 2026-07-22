/**
 * A single clip on a timeline track: the selectable, draggable rectangle with
 * its content preview, badges, trim handles and fade corners. The gesture
 * machinery lives in `hooks/useClipDrag.ts`, the drag math in `clipDrag.ts`,
 * and the purely visual layers in `Filmstrip` / `ClipFades` / `ClipVolumeLine`.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Music, Type } from 'lucide-react';
import { Clip } from '../types';
import { audioTrackForClip, clipDurationMs } from '../model';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { clamp, formatTime } from '../lib/time';
import { gainDb } from '../inspector/format';
import { UNITY_FADER, gainToFader } from '../lib/gain';
import { useVolumeEntry } from '../ui/VolumeEntry';
import { useIsCoarsePointer } from '../lib/device';
import { CLIP_COLORS } from '../lib/palette';
import { Waveform } from './Waveform';
import { Filmstrip } from './Filmstrip';
import { ClipFades } from './ClipFades';
import { ClipKeyframes } from './ClipKeyframes';
import { ClipVolumeLine } from './ClipVolumeLine';
import { useClipDrag } from './hooks/useClipDrag';

interface Props {
  clip: Clip;
  trackKind: 'video' | 'audio';
  /** 1-based track position, for the clip's accessible name. */
  trackNumber: number;
  pxPerMs: number;
  /** Overlap with the neighboring clips (crossfade windows), for the visuals. */
  xfadeInMs?: number;
  xfadeOutMs?: number;
}

export const ClipView = memo(function ClipView({
  clip,
  trackKind,
  trackNumber,
  pxPerMs,
  xfadeInMs = 0,
  xfadeOutMs = 0,
}: Props) {
  const { t } = useTranslation();
  // Subscribe to just this clip's selected flag, so a selection change (or a
  // marquee drag) only re-renders the clips whose membership actually flipped -
  // not every clip on every track through the parent row.
  const selected = useStore((s) => s.selectedClipIds.includes(clip.id));
  const asset = useStore((s) => s.assets[clip.assetId]);
  const padLeft = useStore((s) => s.timelinePadLeft);
  const coarse = useIsCoarsePointer();
  /** This clip's floating drag readout (store-held, so it survives a remount). */
  const dragBadgeText = useStore((s) =>
    s.dragBadge?.clipId === clip.id ? s.dragBadge.text : null,
  );

  const durMs = clipDurationMs(clip);
  const left = padLeft + clip.timelineStartMs * pxPerMs;
  const width = Math.max(6, durMs * pxPerMs);

  const { beginDrag, onPointerMove, onPointerUp } = useClipDrag({
    clip,
    asset,
    trackKind,
    selected,
    coarse,
    durMs,
  });

  // The source audio track this clip draws its waveform from. When the source
  // carries several audio tracks, label the clip with which one it plays.
  const audioInfo = asset ? audioTrackForClip(asset, clip) : undefined;
  const hasPeaks = (audioInfo?.peaks?.length ?? 0) > 0;
  // Clips whose `volume` actually does something: media with an audio track.
  // Text/solid clips and silent footage get no volume line.
  const hasAudio = clip.kind === 'media' && (audioInfo != null || hasPeaks);
  const volumeFader = gainToFader(clip.volume);
  const volumeEntry = useVolumeEntry({
    gain: clip.volume,
    onCommit: (volume) => useStore.getState().updateClipCommitted(clip.id, { volume }),
  });
  // Gain actually trimmed away from unity - the only case where the volume
  // line is worth drawing on an idle clip.
  const gainTrimmed = Math.abs(volumeFader - UNITY_FADER) > 0.001;
  // Only an audio clip pins a single source track worth labelling - a video clip
  // delegates all of them, so it gets no track badge.
  const trackBadge =
    trackKind === 'audio' && asset && asset.audioTracks.length > 1 && audioInfo
      ? (audioInfo.language?.toUpperCase() ??
        t('clip.audioTrack', { n: asset.audioTracks.indexOf(audioInfo) + 1 }))
      : null;

  const isVideo = trackKind === 'video';
  const border = selected
    ? 'ring-2 ring-sky-400 border-transparent'
    : isVideo
      ? 'border-sky-900'
      : 'border-emerald-900';
  // Unselected on touch: no touch-action lock, so a horizontal pan scrubs the timeline.
  const touch = coarse && !selected ? '' : 'touch-none';
  // `isolate` below gives the clip its own stacking context. Its inner
  // z-10/z-20/z-30 (volume line, grab band, badges) have to stay inside it:
  // the sticky track header is z-20 and a clip is rendered after it, so
  // otherwise those layers would paint over the gutter.

  return (
    <div
      data-clip-id={clip.id}
      data-clip-kind={trackKind}
      // Screen-reader/keyboard surface: the clip is a focusable, named button
      // whose pressed state mirrors the selection, and Enter/Space select it so
      // the keyboard shortcuts have a target.
      role="button"
      tabIndex={0}
      aria-label={t('a11y.clip.label', {
        name:
          clip.kind === 'text'
            ? clip.text.content
            : clip.kind === 'solid'
              ? t(`clip.solid.${clip.solid.kind}`)
              : clip.kind === 'shape'
                ? t(`clip.shape.${clip.shape.kind}`)
                : (asset?.file.name ?? ''),
        start: formatTime(clip.timelineStartMs),
        end: formatTime(clip.timelineStartMs + durMs),
        track: trackNumber,
      })}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Space only when the focus is keyboard-driven, mirroring the global
        // hotkeys guard: focus a click left behind keeps Space on play/pause.
        if (e.key === ' ') {
          let visible = true;
          try {
            visible = e.currentTarget.matches(':focus-visible');
          } catch {
            // Unknown selector: keep the accessibility-safe behavior.
          }
          if (!visible) return;
        }
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().selectClip(clip.id);
      }}
      className={`group absolute top-1 bottom-1 isolate overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${touch} ${border} ${isVideo ? 'bg-sky-950' : 'bg-emerald-950'}`}
      style={{ left, width }}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => {
        if (coarse && !selected) useStore.getState().selectClip(clip.id);
      }}
      onDoubleClick={(e) => {
        if (coarse) return;
        e.stopPropagation();
        // Vegas-style: double-click turns the clip's bounds into the selection
        // region (yellow corners) - ready to loop, review or export that span.
        useStore
          .getState()
          .setLoopRegion({ startMs: clip.timelineStartMs, endMs: clip.timelineStartMs + durMs });
      }}
      onContextMenu={(e) => {
        if (coarse) return; // Desktop only: leave the native menu on touch long-press.
        e.preventDefault();
        e.stopPropagation();
        const state = useStore.getState();
        // Right-clicking outside the current selection selects this clip; a
        // right-click inside a multi-selection keeps it, so "delete" hits all.
        if (!state.selectedClipIds.includes(clip.id)) state.selectClip(clip.id);
        state.openContextMenu(e.clientX, e.clientY, { kind: 'clip', clipId: clip.id });
      }}
    >
      {clip.kind === 'text' ? (
        <div className="pointer-events-none flex h-full w-full items-center gap-1 bg-gradient-to-b from-violet-900/60 to-violet-950 px-1.5">
          <Type className="h-3 w-3 flex-none text-violet-300" />
          <span className="truncate text-2xs font-medium text-violet-100">
            {clip.text.content.split('\n')[0] || t('clip.text.placeholder')}
          </span>
        </div>
      ) : clip.kind === 'solid' ? (
        <div
          className="pointer-events-none flex h-full w-full items-center gap-1 px-1.5"
          style={{
            background:
              clip.solid.kind === 'gradient'
                ? `linear-gradient(${clip.solid.angle ?? 0}deg, ${clip.solid.color}, ${clip.solid.color2 ?? clip.solid.color})`
                : clip.solid.color,
          }}
        >
          <span className="truncate text-2xs font-medium text-white drop-shadow">{t(`clip.solid.${clip.solid.kind}`)}</span>
        </div>
      ) : clip.kind === 'shape' ? (
        <div className="pointer-events-none flex h-full w-full items-center gap-1 bg-gradient-to-b from-amber-900/60 to-amber-950 px-1.5">
          {/* A swatch of the actual fill: the fastest way to tell two shape
              clips apart at a glance on a dense timeline. */}
          <span
            className="h-3 w-3 flex-none rounded-sm border border-black/40"
            style={{
              background: clip.shape.fill,
              borderRadius: clip.shape.kind === 'ellipse' ? '9999px' : undefined,
            }}
          />
          <span className="truncate text-2xs font-medium text-amber-100">
            {t(`clip.shape.${clip.shape.kind}`)}
          </span>
        </div>
      ) : isVideo && asset?.thumbnails.length ? (
        /* A video clip's audio lives on its own linked audio track, so the
           filmstrip stays picture-only - no waveform overlay here. */
        <div className="pointer-events-none h-full w-full">
          <Filmstrip asset={asset} clip={clip} widthPx={width} clipLeftPx={left} />
        </div>
      ) : (
        <div className="pointer-events-none relative h-full w-full bg-gradient-to-b from-emerald-900/60 to-emerald-950">
          {hasPeaks && asset && (
            <div className="absolute inset-0">
              <Waveform asset={asset} clip={clip} widthPx={width} clipLeftPx={left} color={CLIP_COLORS.audioWaveform} />
            </div>
          )}
          <div className="absolute left-0 top-0 flex max-w-full items-center gap-1 px-1.5 py-0.5">
            {clip.linkId ? (
              <Link2 className="h-3 w-3 flex-none text-emerald-300" />
            ) : (
              <Music className="h-3 w-3 flex-none text-emerald-300" />
            )}
            <span className="truncate text-3xs text-emerald-100">{asset?.file.name}</span>
            {trackBadge && (
              <span className="flex-none rounded bg-emerald-800/80 px-1 text-4xs font-medium text-emerald-100">
                {trackBadge}
              </span>
            )}
          </div>
        </div>
      )}

      {/* A/V-link badge: this video clip's audio lives on a linked audio clip. */}
      {isVideo && clip.kind === 'media' && clip.linkId && (
        <div className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/55 p-0.5">
          <Link2 className="h-2.5 w-2.5 text-sky-200" />
        </div>
      )}

      {/* Speed / volume badge */}
      {(clip.speed !== 1 || clip.volume !== 1) && (
        <div className="pointer-events-none absolute right-1 top-0.5 rounded bg-black/60 px-1 text-4xs text-zinc-200">
          {clip.speed !== 1 ? `${clip.speed}×` : ''}
          {clip.speed !== 1 && clip.volume !== 1 ? ' · ' : ''}
          {clip.volume !== 1 ? gainDb(clip.volume) : ''}
        </div>
      )}

      {/* Live drag readout: position (move), cut point (roll), duration (trim)
          or source offset (slip) with the delta since the press - CapCut's trim
          bubble and the pro-NLE numeric feedback in one. Store-held so it
          survives the remount when the drag crosses onto another track. */}
      {dragBadgeText && (
        <div className="pointer-events-none absolute left-1/2 top-1 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-950/85 px-1.5 py-0.5 font-mono text-3xs leading-tight text-zinc-100 shadow">
          {dragBadgeText}
        </div>
      )}

      {/* Trim handles (touch: only once selected, CapCut-style) */}
      {(!coarse || selected) && (
        <>
          <div
            className={`absolute inset-y-0 left-0 cursor-ew-resize touch-none ${coarse ? 'w-6' : 'w-3'} ${selected ? 'bg-sky-400/80' : 'bg-white/10'}`}
            onPointerDown={(e) => beginDrag(e, 'trim-left')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {selected && (
              <div className="pointer-events-none absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded bg-zinc-900/70" />
            )}
          </div>
          <div
            className={`absolute inset-y-0 right-0 cursor-ew-resize touch-none ${coarse ? 'w-6' : 'w-3'} ${selected ? 'bg-sky-400/80' : 'bg-white/10'}`}
            onPointerDown={(e) => beginDrag(e, 'trim-right')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {selected && (
              <div className="pointer-events-none absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded bg-zinc-900/70" />
            )}
          </div>
        </>
      )}

      <ClipFades clip={clip} width={width} pxPerMs={pxPerMs} xfadeInMs={xfadeInMs} xfadeOutMs={xfadeOutMs} />

      {/* Keyframe markers on the selected clip (click a diamond to jump to it). */}
      {selected && <ClipKeyframes clip={clip} pxPerMs={pxPerMs} coarse={coarse} />}

      {hasAudio && (
        <ClipVolumeLine
          clipId={clip.id}
          volumeFader={volumeFader}
          gainTrimmed={gainTrimmed}
          selected={selected}
          coarse={coarse}
          volumeEntry={volumeEntry}
          beginDrag={beginDrag}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      )}

      {/* Fade handles: drag from the clip's top corners to fade from/to black.
          The interactive box is deliberately larger than the visible dot so the
          corner is easy to grab; the dot itself sits at the ramp's top. */}
      {selected && (
        <>
          <Tooltip label={t('clip.fadeIn')}>
            <div
              className={`absolute top-0 z-10 flex -translate-x-1/2 items-start justify-center cursor-ew-resize touch-none ${coarse ? 'h-8 w-8' : 'h-6 w-6'}`}
              style={{ left: clamp(clip.fadeInMs * pxPerMs, 6, Math.max(6, width / 2)) }}
              onPointerDown={(e) => beginDrag(e, 'fade-in')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span
                className={`pointer-events-none rounded-full border border-zinc-900 bg-amber-300 shadow ${coarse ? 'h-4 w-4' : 'h-3 w-3'}`}
              />
            </div>
          </Tooltip>
          <Tooltip label={t('clip.fadeOut')}>
            <div
              className={`absolute top-0 z-10 flex -translate-x-1/2 items-start justify-center cursor-ew-resize touch-none ${coarse ? 'h-8 w-8' : 'h-6 w-6'}`}
              style={{ left: clamp(width - clip.fadeOutMs * pxPerMs, Math.min(width - 6, width / 2), width - 6) }}
              onPointerDown={(e) => beginDrag(e, 'fade-out')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span
                className={`pointer-events-none rounded-full border border-zinc-900 bg-amber-300 shadow ${coarse ? 'h-4 w-4' : 'h-3 w-3'}`}
              />
            </div>
          </Tooltip>
        </>
      )}
    </div>
  );
});
