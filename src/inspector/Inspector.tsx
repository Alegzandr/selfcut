import { useMemo } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Cross2Icon, TrashIcon } from '@radix-ui/react-icons';
import { useStore, getSelectedClip } from '../store/store';
import type { InspectorTab } from '../store/editorState';
import { SubtitlesPanel } from './SubtitlesPanel';
import { useCaptionJob } from '../media/captionJob';
import { Tooltip } from '../ui/Tooltip';
import { Clip } from '../types';
import { isTextClip } from '../model';
import { useIsCoarsePointer } from '../lib/device';
import { ResizeHandle } from '../ui/ResizeHandle';
import { INSPECTOR_WIDTH_PX } from '../app/config';
import { PERCENT_ENTRY, SliderRow } from './SliderRow';
import { TextSection } from './sections/TextSection';
import { SolidSection } from './sections/SolidSection';
import { ShapeSection } from './sections/ShapeSection';
import { SpeedControl } from './sections/SpeedControl';
import { AudioSection } from './sections/AudioSection';
import { FadeSection } from './sections/FadeSection';
import { TransformSection } from './sections/TransformSection';
import { ColorSection } from './sections/ColorSection';
import { CurvesSection } from './sections/CurvesSection';
import { ChromaSection } from './sections/ChromaSection';
import { MaskSection } from './sections/MaskSection';
import { RedactionSection } from './sections/RedactionSection';
import { TransitionSection } from './sections/TransitionSection';
import { clipDisplayName } from '../ui/clipName';

/**
 * Tab strip of the inspector column, shown whenever the column is up.
 *
 * It used to appear only once the cue list had been asked for, which made
 * subtitles - and with them auto-captions - reachable exclusively through a
 * View menu entry nobody thinks to open. A pane that cannot be found is a
 * feature that does not exist, and one extra row of tabs is a small price for
 * the whole of it becoming visible.
 */
function InspectorTabs({ cueCount }: { cueCount: number }) {
  const { t } = useTranslation();
  const tab = useStore((s) => s.inspectorTab);
  const setInspectorTab = useStore.getState().setInspectorTab;
  // A transcription outlives the panel that started it (see `captionJob`), and
  // the tab strip is the only part of it still on screen once the clip pane
  // takes over. Without this, leaving the tab looked exactly like nothing
  // running - which is how someone ends up asking for the job twice.
  const captions = useCaptionJob();
  const tabs: {
    id: InspectorTab;
    label: string;
    badge?: number;
    /** 0..1 of a job running behind this tab; null = running, unmeasurable. */
    progress?: number | null;
  }[] = [
    { id: 'clip', label: t('inspector.tab.clip') },
    {
      id: 'subtitles',
      label: t('inspector.tab.subtitles'),
      badge: cueCount || undefined,
      ...(captions ? { progress: captions.value } : {}),
    },
  ];
  return (
    // Real ARIA tabs, not buttons that look like tabs. Assistive tech gets the
    // "1 of 2" it needs, and the menu bar keeps sole ownership of the button
    // role for its own "Clip" menu - two controls with the same name and the
    // same role is ambiguous to a screen reader before it is ambiguous to a test.
    <div role="tablist" aria-label={t('inspector.tabs')} className="flex gap-1 rounded-lg bg-zinc-800/60 p-0.5">
      {tabs.map(({ id, label, badge, progress }) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          className={`relative flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-md px-2 py-1 text-xs font-medium ${
            tab === id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
          }`}
          onClick={() => setInspectorTab(id)}
        >
          {label}
          {badge != null && (
            <span className="rounded-full bg-zinc-700/80 px-1.5 text-2xs tabular-nums text-zinc-300">
              {badge}
            </span>
          )}
          {/* A hairline along the tab's own edge rather than a number or a
              spinner: it says "still going, in here" without competing with the
              cue count for the two words of room this strip has. */}
          {progress !== undefined && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-600/60">
              <span
                className={`block h-full bg-brand-400 ${progress == null ? 'w-full opacity-60' : 'transition-[width]'}`}
                style={progress == null ? undefined : { width: `${Math.round(progress * 100)}%` }}
              />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Inspector() {
  const { t } = useTranslation();
  const clip = useStore(getSelectedClip);
  const asset = useStore((s) => (clip ? s.assets[clip.assetId] : undefined));
  const coarse = useIsCoarsePointer();
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const tab = useStore((s) => s.inspectorTab);
  const inspectorWidthPx = useStore((s) => s.inspectorWidthPx);
  const showSubtitles = tab === 'subtitles';
  // Counted here rather than in the panel: the tab badge has to state how many
  // cues the project holds even while the clip pane is the one on screen.
  const tracks = useStore((s) => s.project.tracks);
  const cueCount = useMemo(
    () => tracks.reduce((n, track) => n + track.clips.filter(isTextClip).length, 0),
    [tracks],
  );
  // A linked video clip delegates its sound to the audio clip on the lane
  // below (it is silent in the mix): audio edits must target that partner,
  // otherwise the volume/balance controls are dead knobs.
  // Derived from `project` rather than inside a selector: a store selector runs
  // on every set(), and the playback engine writes the current time 60 times a
  // second, so this track scan used to run once per frame during playback.
  const project = useStore((s) => s.project);
  // Which lane the clip sits on: the audio half of a linked pair shares the
  // video asset of its partner, so `asset.kind` alone would hand it the picture
  // sections (transform, colour, blur) for a waveform.
  const onVideoTrack = useMemo(
    () =>
      !clip ||
      project.tracks.find((tr) => tr.clips.some((c) => c.id === clip.id))?.kind !== 'audio',
    [project, clip],
  );
  const audioClip = useMemo(() => {
    if (!clip?.linkId) return clip;
    for (const track of project.tracks) {
      if (track.kind !== 'audio') continue;
      const partner = track.clips.find((c) => c.linkId === clip.linkId && c.id !== clip.id);
      if (partner) return partner;
    }
    return clip;
  }, [project, clip]);

  // Desktop: docked column next to the preview - it must never cover the
  // timeline, that is where the cutting happens. Mobile: bottom sheet opened
  // on demand from the clip action bar ("Adjust"), CapCut-style.
  // The cue list stands on its own: unlike the clip pane it stays useful with
  // nothing selected, so it alone can keep the column up.
  if (!coarse) {
    if (!clip && !showSubtitles) return null;
    return (
      // The handle rides the column's left edge, so it appears and disappears
      // with the column instead of leaving an orphan divider next to the preview.
      <>
        <ResizeHandle
          width={inspectorWidthPx}
          onWidth={useStore.getState().setInspectorWidthPx}
          defaultWidth={INSPECTOR_WIDTH_PX}
          side="start"
        />
        <div
          // The gutter is reserved whether or not the pane scrolls: the clip
          // tab overflows and the subtitles tab often does not, and without it
          // every switch between the two shifted the whole column sideways by
          // the width of the scrollbar.
          className="flex-none space-y-3 overflow-x-hidden overflow-y-auto border-l border-zinc-800 bg-zinc-900/60 p-3 [scrollbar-gutter:stable]"
          style={{ width: inspectorWidthPx }}
        >
          <InspectorTabs cueCount={cueCount} />
          {showSubtitles ? (
            <SubtitlesPanel />
          ) : (
            clip && (
              <InspectorBody
                clip={clip}
                audioClip={audioClip ?? clip}
                isVideo={onVideoTrack && !!asset && asset.kind !== 'audio'}
                hasAudio={asset?.hasAudio ?? false}
                name={clipDisplayName(clip, asset, t)}
              />
            )
          )}
        </div>
      </>
    );
  }

  const show = (clip || showSubtitles) && inspectorOpen;
  return (
    <AnimatePresence>
      {show && (
        <m.div
          key={showSubtitles ? 'subtitles' : clip!.id}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[55dvh] space-y-3 overflow-x-hidden overflow-y-auto rounded-t-2xl [scrollbar-gutter:stable] border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black"
        >
          <InspectorTabs cueCount={cueCount} />
          {showSubtitles ? (
            <SubtitlesPanel />
          ) : (
            clip && (
              <InspectorBody
                clip={clip}
                audioClip={audioClip ?? clip}
                isVideo={onVideoTrack && !!asset && asset.kind !== 'audio'}
                hasAudio={asset?.hasAudio ?? false}
                name={clipDisplayName(clip, asset, t)}
              />
            )
          )}
        </m.div>
      )}
    </AnimatePresence>
  );
}

function InspectorBody({
  clip,
  audioClip,
  isVideo,
  hasAudio,
  name,
}: {
  clip: Clip;
  /** The clip whose audio the controls edit: the linked audio partner of a video clip, else the clip itself. */
  audioClip: Clip;
  isVideo: boolean;
  hasAudio: boolean;
  name: string;
}) {
  const { t } = useTranslation();
  const { updateClip, deleteClips, selectClip, setInspectorOpen } = useStore.getState();
  const coarse = useIsCoarsePointer();
  const isText = clip.kind === 'text';
  const isShape = clip.kind === 'shape';

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{name}</h2>
        <Tooltip label={t('inspector.deleteClip')}>
          <button
            className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 pointer-coarse:p-2.5"
            // The whole selection, like every other delete surface: two trash
            // buttons on screen must not mean two different things.
            onClick={() => deleteClips(useStore.getState().selectedClipIds, false)}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t('inspector.close')}>
          <button
            className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800 pointer-coarse:p-2.5"
            onClick={() => (coarse ? setInspectorOpen(false) : selectClip(null))}
          >
            <Cross2Icon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {clip.kind === 'text' && <TextSection clip={clip} />}
      {clip.kind === 'solid' && <SolidSection clip={clip} />}
      {clip.kind === 'shape' && <ShapeSection clip={clip} />}

      {hasAudio && <AudioSection clip={audioClip} />}
      {!isText && <SpeedControl clip={clip} />}
      <FadeSection clip={clip} />

      {isVideo && (
        <SliderRow
          label={t('inspector.zoomAnim')}
          value={clip.zoomEnd ?? 1}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => (v === 1 ? t('inspector.zoomAnim.off') : `→${Math.round(v * 100)}%`)}
          entry={PERCENT_ENTRY}
          onChange={(v) => updateClip(clip.id, { zoomEnd: v })}
        />
      )}

      {(isVideo || isText || isShape) && <TransformSection clip={clip} isVideo={isVideo} />}
      {(isVideo || isText || isShape) && <MaskSection clip={clip} />}
      {(isVideo || isText || isShape) && <RedactionSection clip={clip} />}
      {isVideo && <ColorSection clip={clip} />}
      {isVideo && <CurvesSection clip={clip} />}
      {isVideo && <ChromaSection clip={clip} />}
      {(isVideo || isText || isShape) && <TransitionSection clip={clip} />}
    </>
  );
}
