import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import { useStore, getSelectedClip } from '../store/store';
import type { InspectorTab } from '../store/editorState';
import { SubtitlesPanel } from './SubtitlesPanel';
import { Tooltip } from '../ui/Tooltip';
import type { TFunction } from 'i18next';
import { Clip, MediaAsset } from '../types';
import { useIsCoarsePointer } from '../lib/device';
import { ResizeHandle } from '../ui/ResizeHandle';
import { INSPECTOR_WIDTH_PX } from '../app/config';
import { SliderRow } from './SliderRow';
import { TextSection } from './sections/TextSection';
import { SolidSection } from './sections/SolidSection';
import { ShapeSection } from './sections/ShapeSection';
import { SpeedControl } from './sections/SpeedControl';
import { AudioSection } from './sections/AudioSection';
import { FadeSection } from './sections/FadeSection';
import { TransformSection } from './sections/TransformSection';
import { ColorSection } from './sections/ColorSection';
import { TransitionSection } from './sections/TransitionSection';

/**
 * Heading of the inspector: a generated clip is named after what it renders, a
 * media clip after its file. Shared by the docked column and the mobile sheet -
 * which is why it is a function and not an inline ternary in both.
 */
function clipDisplayName(clip: Clip, asset: MediaAsset | undefined, t: TFunction): string {
  switch (clip.kind) {
    case 'text':
      return t('inspector.textClip');
    case 'solid':
      return t(`inspector.solid.${clip.solid.kind}`);
    case 'shape':
      return t(`preview.shape.${clip.shape.kind}`);
    default:
      return asset?.file.name ?? '';
  }
}

/**
 * Tab strip of the inspector column. Only shown once the cue list has been
 * asked for: a single-pane inspector must not grow a tab bar for a pane the
 * user never opened.
 */
function InspectorTabs() {
  const { t } = useTranslation();
  const tab = useStore((s) => s.inspectorTab);
  const setInspectorTab = useStore.getState().setInspectorTab;
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: 'clip', label: t('inspector.tab.clip') },
    { id: 'subtitles', label: t('inspector.tab.subtitles') },
  ];
  return (
    <div className="flex gap-1 rounded-lg bg-zinc-800/60 p-0.5">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
            tab === id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
          }`}
          onClick={() => setInspectorTab(id)}
        >
          {label}
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
  // A linked video clip delegates its sound to the audio clip on the lane
  // below (it is silent in the mix): audio edits must target that partner,
  // otherwise the volume/balance controls are dead knobs.
  // Derived from `project` rather than inside a selector: a store selector runs
  // on every set(), and the playback engine writes the current time 60 times a
  // second, so this track scan used to run once per frame during playback.
  const project = useStore((s) => s.project);
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
          className="flex-none space-y-3 overflow-x-hidden overflow-y-auto border-l border-zinc-800 bg-zinc-900/60 p-3"
          style={{ width: inspectorWidthPx }}
        >
          {showSubtitles && <InspectorTabs />}
          {showSubtitles ? (
            <SubtitlesPanel />
          ) : (
            clip && (
              <InspectorBody
                clip={clip}
                audioClip={audioClip ?? clip}
                isVideo={!!asset && asset.kind !== 'audio'}
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
        <motion.div
          key={showSubtitles ? 'subtitles' : clip!.id}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[55dvh] space-y-3 overflow-x-hidden overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black"
        >
          {showSubtitles && <InspectorTabs />}
          {showSubtitles ? (
            <SubtitlesPanel />
          ) : (
            clip && (
              <InspectorBody
                clip={clip}
                audioClip={audioClip ?? clip}
                isVideo={!!asset && asset.kind !== 'audio'}
                hasAudio={asset?.hasAudio ?? false}
                name={clipDisplayName(clip, asset, t)}
              />
            )
          )}
        </motion.div>
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
            className="touch-hit rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800 pointer-coarse:p-2.5"
            // The whole selection, like every other delete surface: two trash
            // buttons on screen must not mean two different things.
            onClick={() => deleteClips(useStore.getState().selectedClipIds, false)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t('inspector.close')}>
          <button
            className="touch-hit rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800 pointer-coarse:p-2.5"
            onClick={() => (coarse ? setInspectorOpen(false) : selectClip(null))}
          >
            <X className="h-4 w-4" />
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
          onChange={(v) => updateClip(clip.id, { zoomEnd: v })}
        />
      )}

      {(isVideo || isText || isShape) && <TransformSection clip={clip} isVideo={isVideo} />}
      {isVideo && <ColorSection clip={clip} />}
      {(isVideo || isText || isShape) && <TransitionSection clip={clip} />}
    </>
  );
}
