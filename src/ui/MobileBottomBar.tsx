import type { ComponentType } from 'react';
import type { ParseKeys } from 'i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FolderPlus, Trash2 } from 'lucide-react';
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
  /**
   * Optional icon override. Left out, the tile draws the command's own icon, so
   * an action cannot end up wearing one glyph on desktop and another on touch -
   * Scissors used to mean "cut" in the menus and "split" down here.
   * Override only where the larger touch tile earns a more literal glyph.
   */
  icon?: ComponentType<{ className?: string }>;
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
  // "Import media" reads better as a folder with a plus than as the menu's
  // generic file glyph, and this tile is the entry point of the whole app.
  { cmd: 'file.import', icon: FolderPlus, labelKey: 'mobile.media' },
  { cmd: 'edit.paste', labelKey: 'clipbar.paste' },
  { cmd: 'insert.text', labelKey: 'mobile.text' },
  { cmd: 'insert.color', labelKey: 'mobile.color' },
  { cmd: 'insert.gradient', labelKey: 'mobile.gradient' },
  { cmd: 'insert.audioTrack', labelKey: 'mobile.audio' },
  { cmd: 'insert.videoTrack', labelKey: 'mobile.video' },
  { cmd: 'insert.marker', labelKey: 'mobile.marker' },
  // Touch has no menu bar: preferences (language, time format) need a tile.
  { cmd: 'edit.preferences', labelKey: 'mobile.settings' },
];

const CLIP_TILES: readonly Tile[] = [
  { cmd: 'clip.split', labelKey: 'clipbar.split' },
  { cmd: 'edit.copy', labelKey: 'clipbar.copy' },
  { cmd: 'edit.paste', labelKey: 'clipbar.paste' },
  { cmd: 'clip.duplicate', labelKey: 'clipbar.duplicate' },
  { cmd: 'clip.punchIn', labelKey: 'clipbar.punchIn' },
  { cmd: 'clip.stream', labelKey: 'clipbar.stream', mediaOnly: true },
  { cmd: 'clip.adjust', labelKey: 'clipbar.adjust' },
  { cmd: 'clip.link', labelKey: 'clipbar.link', linkableOnly: true },
  { cmd: 'clip.unlink', labelKey: 'clipbar.unlink', linkedOnly: true },
  // Touch gets a single "Delete" that closes the gap (ripple), matching the
  // CapCut-style expectation. The plain "leave a gap" delete stays desktop-only
  // where a monteur has the keyboard shortcut (Del vs Shift+Del) and the mental
  // model for it - two identical trash icons and the word "ripple" only confuse
  // a casual mobile user.
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
        const Icon = tile.icon ?? command.icon;
        if (!Icon) return null;
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
              <Icon className="h-5 w-5" />
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
