import type { ComponentType } from 'react';
import type { ParseKeys } from 'i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  Blend,
  Copy,
  CopyPlus,
  Film,
  FolderPlus,
  MapPin,
  Music,
  Scissors,
  SlidersHorizontal,
  LayoutPanelTop,
  Link2,
  Trash2,
  Type,
  Unlink,
  ZoomIn,
} from 'lucide-react';
import { useStore, getSelectedClip, getLinkTargets } from '../store/store';
import { useIsCoarsePointer } from '../lib/device';
import { useEditorCommands } from './commands';

/**
 * CapCut-style bottom bar (touch only). It is a persistent flow element - the
 * timeline shrinks to make room, rather than being covered by a floating bar.
 * Its content swaps with the selection:
 *  - no clip selected → a scrollable rail of creation tools (add media/text/…);
 *  - a clip selected → a scrollable rail of contextual clip actions.
 * The media library and the inspector open as sheets *over* this bar.
 */
type Tile = {
  /** Command id from the shared registry (its handler + disabled state). */
  cmd: string;
  icon: ComponentType<{ className?: string }>;
  labelKey: ParseKeys;
  danger?: boolean;
  /** Clip rail only: hide the tile unless the selected clip is real media. */
  mediaOnly?: boolean;
  /** Clip rail only: hide the tile unless the selected clip is A/V-linked. */
  linkedOnly?: boolean;
  /** Clip rail only: hide the tile unless the selection can be A/V-linked. */
  linkableOnly?: boolean;
};

const TOOL_TILES: readonly Tile[] = [
  { cmd: 'file.import', icon: FolderPlus, labelKey: 'mobile.media' },
  { cmd: 'insert.text', icon: Type, labelKey: 'mobile.text' },
  { cmd: 'insert.color', icon: Blend, labelKey: 'mobile.color' },
  { cmd: 'insert.gradient', icon: Blend, labelKey: 'mobile.gradient' },
  { cmd: 'insert.audioTrack', icon: Music, labelKey: 'mobile.audio' },
  { cmd: 'insert.videoTrack', icon: Film, labelKey: 'mobile.video' },
  { cmd: 'insert.marker', icon: MapPin, labelKey: 'mobile.marker' },
];

const CLIP_TILES: readonly Tile[] = [
  { cmd: 'clip.split', icon: Scissors, labelKey: 'clipbar.split' },
  { cmd: 'edit.copy', icon: Copy, labelKey: 'clipbar.copy' },
  { cmd: 'clip.duplicate', icon: CopyPlus, labelKey: 'clipbar.duplicate' },
  { cmd: 'clip.punchIn', icon: ZoomIn, labelKey: 'clipbar.punchIn' },
  { cmd: 'clip.stream', icon: LayoutPanelTop, labelKey: 'clipbar.stream', mediaOnly: true },
  { cmd: 'clip.adjust', icon: SlidersHorizontal, labelKey: 'clipbar.adjust' },
  { cmd: 'clip.link', icon: Link2, labelKey: 'clipbar.link', linkableOnly: true },
  { cmd: 'clip.unlink', icon: Unlink, labelKey: 'clipbar.unlink', linkedOnly: true },
  { cmd: 'clip.rippleDelete', icon: Trash2, labelKey: 'clipbar.delete', danger: true },
];

function Rail({ tiles }: { tiles: readonly Tile[] }) {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  return (
    <div className="flex gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tiles.map((tile) => {
        const command = commands[tile.cmd];
        if (!command) return null;
        const color = tile.danger ? 'text-red-300' : 'text-zinc-300';
        return (
          <button
            key={tile.cmd}
            type="button"
            disabled={command.disabled}
            className={`flex min-w-16 flex-none flex-col items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-medium ${color} active:bg-zinc-800 disabled:opacity-30`}
            onClick={command.onClick}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/70">
              <tile.icon className="h-5 w-5" />
            </span>
            {t(tile.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

export function MobileBottomBar() {
  const coarse = useIsCoarsePointer();
  const clip = useStore(getSelectedClip);
  const canLink = useStore((s) => getLinkTargets(s) !== null);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  if (!coarse) return null;

  // A selected clip shows its action rail; the inspector sheet (Adjust) takes
  // over the bottom of the screen, so fall back to the tools rail behind it.
  const showClip = clip !== null && !inspectorOpen;
  const tiles = showClip
    ? CLIP_TILES.filter(
        (tile) =>
          (!tile.mediaOnly || clip.assetId !== '') &&
          (!tile.linkedOnly || clip.linkId != null) &&
          (!tile.linkableOnly || canLink),
      )
    : TOOL_TILES;

  return (
    <nav className="flex-none border-t border-zinc-800 bg-zinc-900/95 pb-[max(0.25rem,env(safe-area-inset-bottom))] backdrop-blur">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={showClip ? 'clip' : 'tools'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.12 }}
        >
          <Rail tiles={tiles} />
        </motion.div>
      </AnimatePresence>
    </nav>
  );
}
