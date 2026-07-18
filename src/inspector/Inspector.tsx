import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import { useStore, getSelectedClip } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { Clip } from '../types';
import { useIsCoarsePointer } from '../lib/device';
import { SliderRow } from './SliderRow';
import { TextSection } from './sections/TextSection';
import { SolidSection } from './sections/SolidSection';
import { SpeedControl } from './sections/SpeedControl';
import { AudioSection } from './sections/AudioSection';
import { FadeSection } from './sections/FadeSection';
import { TransformSection } from './sections/TransformSection';

export function Inspector() {
  const { t } = useTranslation();
  const clip = useStore(getSelectedClip);
  const asset = useStore((s) => (clip ? s.assets[clip.assetId] : undefined));
  const coarse = useIsCoarsePointer();
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  // A linked video clip delegates its sound to the audio clip on the lane
  // below (it is silent in the mix): audio edits must target that partner,
  // otherwise the volume/balance controls are dead knobs.
  const audioClip = useStore((s) => {
    if (!clip?.linkId) return clip;
    for (const track of s.project.tracks) {
      if (track.kind !== 'audio') continue;
      const partner = track.clips.find((c) => c.linkId === clip.linkId && c.id !== clip.id);
      if (partner) return partner;
    }
    return clip;
  });

  // Desktop: docked column next to the preview - it must never cover the
  // timeline, that is where the cutting happens. Mobile: bottom sheet opened
  // on demand from the clip action bar ("Adjust"), CapCut-style.
  if (!coarse) {
    if (!clip) return null;
    return (
      <div className="w-72 flex-none space-y-3 overflow-x-hidden overflow-y-auto border-l border-zinc-800 bg-zinc-900/60 p-3">
        <InspectorBody
          clip={clip}
          audioClip={audioClip ?? clip}
          isVideo={!!asset && asset.kind !== 'audio'}
          hasAudio={asset?.hasAudio ?? false}
          name={clip.kind === 'text' ? t('inspector.textClip') : clip.kind === 'solid' ? t(`inspector.solid.${clip.solid.kind}`) : asset?.file.name ?? ''}
        />
      </div>
    );
  }

  const show = clip && inspectorOpen;
  return (
    <AnimatePresence>
      {show && clip && (
        <motion.div
          key={clip.id}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[55dvh] space-y-3 overflow-x-hidden overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black"
        >
          <InspectorBody
            clip={clip}
            audioClip={audioClip ?? clip}
            isVideo={!!asset && asset.kind !== 'audio'}
            hasAudio={asset?.hasAudio ?? false}
            name={clip.kind === 'text' ? t('inspector.textClip') : clip.kind === 'solid' ? t(`inspector.solid.${clip.solid.kind}`) : asset?.file.name ?? ''}
          />
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
  const { updateClip, deleteClip, selectClip, setInspectorOpen } = useStore.getState();
  const coarse = useIsCoarsePointer();
  const isText = clip.kind === 'text';

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{name}</h2>
        <Tooltip label={t('inspector.deleteClip')}>
          <button
            className="touch-hit rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800 pointer-coarse:p-2.5"
            onClick={() => deleteClip(clip.id)}
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
          format={(v) => (v === 1 ? 'off' : `→${Math.round(v * 100)}%`)}
          onChange={(v) => updateClip(clip.id, { zoomEnd: v })}
        />
      )}

      {(isVideo || isText) && <TransformSection clip={clip} isVideo={isVideo} />}
    </>
  );
}
