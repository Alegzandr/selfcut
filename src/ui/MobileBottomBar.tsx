import { useState, type ComponentType, type ReactNode } from 'react';
import type { ParseKeys } from 'i18next';
import { AnimatePresence, m } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeftIcon,
  FrameIcon,
  CircleIcon,
  Pencil1Icon,
  SquareIcon,
  TrashIcon,
  TriangleUpIcon,
  UploadIcon,
} from '@radix-ui/react-icons';
import { useStore, getSelectedClip, getSelectedTrackKind, getLinkTargets } from '../store/store';
import { useIsCoarsePointer } from '../lib/device';
import { useEditorCommands } from './commands';

/**
 * CapCut-style bottom bar (touch only). It is a persistent flow element - the
 * timeline shrinks to make room, rather than being covered by a floating bar.
 * Its content swaps with the selection:
 *  - no clip selected → a scrollable rail of creation tools (add media/text/…);
 *  - a clip selected → a scrollable rail of contextual clip actions.
 *  - either of them → a "Preview" tile opens the monitor rail underneath.
 * The media library and the inspector open as sheets *over* this bar.
 *
 * The monitor rail is the touch home of what the desktop draws floating over
 * the preview: the select / pan / zoom modes, "fit the view", the shape
 * primitives and the mask pen. None of those are in any menu, so before this
 * rail existed they were the one group of features a phone simply did not
 * have - and with no pinch handler on the monitor, a phone could not even zoom
 * the picture it was cutting.
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
  /** Clip rail only: hide the tile unless the clip sits on a video track. */
  pictureOnly?: boolean;
  /** Clip rail only: hide the tile unless the selected clip is A/V-linked. */
  linkedOnly?: boolean;
  /** Clip rail only: hide the tile unless the selection can be A/V-linked. */
  linkableOnly?: boolean;
};

const TOOL_TILES: readonly Tile[] = [
  // "Import media" reads better as an upload arrow than as the menu's
  // generic file glyph, and this tile is the entry point of the whole app.
  { cmd: 'file.import', icon: UploadIcon, labelKey: 'mobile.media' },
  { cmd: 'edit.paste', labelKey: 'clipbar.paste' },
  { cmd: 'insert.text', labelKey: 'mobile.text' },
  { cmd: 'insert.color', labelKey: 'mobile.color' },
  { cmd: 'insert.gradient', labelKey: 'mobile.gradient' },
  { cmd: 'insert.audioTrack', labelKey: 'mobile.audio' },
  { cmd: 'insert.videoTrack', labelKey: 'mobile.video' },
  { cmd: 'insert.marker', labelKey: 'mobile.marker' },
  // Touch has no menu bar, so the two File actions it cannot live without get a
  // tile: importing a preset here, and preferences (language, time format).
  { cmd: 'file.importPreset', labelKey: 'mobile.preset' },
  { cmd: 'edit.preferences', labelKey: 'mobile.settings' },
];

const CLIP_TILES: readonly Tile[] = [
  { cmd: 'clip.split', labelKey: 'clipbar.split' },
  { cmd: 'edit.copy', labelKey: 'clipbar.copy' },
  { cmd: 'edit.paste', labelKey: 'clipbar.paste' },
  { cmd: 'clip.duplicate', labelKey: 'clipbar.duplicate' },
  { cmd: 'clip.punchIn', labelKey: 'clipbar.punchIn', pictureOnly: true },
  { cmd: 'clip.stream', labelKey: 'clipbar.stream', mediaOnly: true, pictureOnly: true },
  { cmd: 'clip.blurRegion', labelKey: 'clipbar.blurRegion', pictureOnly: true },
  { cmd: 'clip.adjust', labelKey: 'clipbar.adjust' },
  { cmd: 'clip.link', labelKey: 'clipbar.link', linkableOnly: true },
  { cmd: 'clip.unlink', labelKey: 'clipbar.unlink', linkedOnly: true },
  // Touch gets a single "Delete" that closes the gap (ripple), matching the
  // CapCut-style expectation. The plain "leave a gap" delete stays desktop-only
  // where a monteur has the keyboard shortcut (Del vs Shift+Del) and the mental
  // model for it - two identical trash icons and the word "ripple" only confuse
  // a casual mobile user.
  { cmd: 'clip.rippleDelete', icon: TrashIcon, labelKey: 'clipbar.delete', danger: true },
];

/** One tile. Shared so a command tile and a mode tile cannot drift apart. */
function RailTile({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  danger,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Mode tiles only (the monitor rail): exactly one of a group is on. */
  active?: boolean;
  danger?: boolean;
}) {
  const color = danger ? 'text-red-300' : active ? 'text-blue-300' : 'text-zinc-300';
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      className={`flex min-w-16 flex-none flex-col items-center gap-1.5 rounded-lg px-2 py-1 text-3xs font-medium ${color} hover:bg-zinc-800/70 active:bg-zinc-800 disabled:opacity-30`}
      onClick={onClick}
    >
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${
          active ? 'bg-blue-500/20' : 'bg-zinc-800/70'
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      {label}
    </button>
  );
}

function RailRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

function Rail({ tiles, onPreview }: { tiles: readonly Tile[]; onPreview: () => void }) {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  return (
    <RailRow>
      {tiles.map((tile) => {
        const command = commands[tile.cmd];
        if (!command) return null;
        const Icon = tile.icon ?? command.icon;
        if (!Icon) return null;
        return (
          <RailTile
            key={tile.cmd}
            icon={Icon}
            label={t(tile.labelKey)}
            disabled={command.disabled}
            danger={tile.danger}
            onClick={command.onClick}
          />
        );
      })}
      {/* Last, after the actions of the rail it hangs off: it is a way in to
          another rail, not one more thing to do to the timeline. */}
      <RailTile icon={FrameIcon} label={t('mobile.preview')} onClick={onPreview} />
    </RailRow>
  );
}

/**
 * The monitor rail: the preview's own tools, which on desktop float over the
 * canvas. The shape primitives are listed flat rather than behind the desktop's
 * flyout - a long-press to reveal a tool group is an Adobe habit, not a phone
 * one, and there are only three of them.
 */
function PreviewRail({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  const previewTool = useStore((s) => s.previewTool);
  const shapeKind = useStore((s) => s.previewShapeKind);
  const hasSelection = useStore((s) => s.selectedClipId !== null);
  const { setPreviewTool, setPreviewShapeKind } = useStore.getState();

  const shapes = [
    { kind: 'rect' as const, icon: SquareIcon, labelKey: 'preview.shape.rect' as ParseKeys },
    { kind: 'ellipse' as const, icon: CircleIcon, labelKey: 'preview.shape.ellipse' as ParseKeys },
    { kind: 'polygon' as const, icon: TriangleUpIcon, labelKey: 'preview.shape.polygon' as ParseKeys },
  ];

  return (
    <RailRow>
      <RailTile icon={ChevronLeftIcon} label={t('mobile.back')} onClick={onBack} />
      {(['preview.toolSelect', 'preview.toolHand', 'preview.toolZoom', 'preview.resetView'] as const).map(
        (id, i) => {
          const command = commands[id];
          const Icon = command?.icon;
          if (!command || !Icon) return null;
          return (
            <RailTile
              key={id}
              icon={Icon}
              label={t((['mobile.select', 'mobile.pan', 'mobile.zoom', 'mobile.fit'] as ParseKeys[])[i]!)}
              disabled={command.disabled}
              active={command.checked}
              onClick={command.onClick}
            />
          );
        },
      )}
      {shapes.map(({ kind, icon, labelKey }) => (
        <RailTile
          key={kind}
          icon={icon}
          label={t(labelKey)}
          // Armed AND drawing: on desktop the flyout picks the primitive and the
          // button arms the tool, but here one tap has to do both or the tile
          // would be a setting with no visible effect.
          active={previewTool === 'shape' && shapeKind === kind}
          onClick={() => {
            setPreviewShapeKind(kind);
            setPreviewTool('shape');
          }}
        />
      ))}
      {/* A mask belongs to a clip, so this one is dead without a selection -
          same rule the desktop pen button follows. */}
      <RailTile
        icon={Pencil1Icon}
        label={t('mobile.mask')}
        disabled={!hasSelection}
        active={previewTool === 'pen'}
        onClick={() => setPreviewTool(previewTool === 'pen' ? 'select' : 'pen')}
      />
    </RailRow>
  );
}

export function MobileBottomBar() {
  const coarse = useIsCoarsePointer();
  const clip = useStore(getSelectedClip);
  const canLink = useStore((s) => getLinkTargets(s) !== null);
  // Blur and reframing need a picture: the audio half of a linked pair carries
  // a video asset, so the lane is what settles it.
  const onVideoTrack = useStore(getSelectedTrackKind) !== 'audio';
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const [showPreviewRail, setShowPreviewRail] = useState(false);
  if (!coarse) return null;

  // A selected clip shows its action rail; the inspector sheet (Adjust) takes
  // over the bottom of the screen, so fall back to the tools rail behind it.
  const showClip = clip !== null && !inspectorOpen;
  const tiles = showClip
    ? CLIP_TILES.filter(
        (tile) =>
          (!tile.mediaOnly || clip.assetId !== '') &&
          (!tile.pictureOnly || onVideoTrack) &&
          (!tile.linkedOnly || clip.linkId != null) &&
          (!tile.linkableOnly || canLink),
      )
    : TOOL_TILES;

  return (
    <nav className="flex-none border-t border-zinc-800 bg-zinc-900/95 pb-[max(0.25rem,env(safe-area-inset-bottom))] backdrop-blur">
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={showPreviewRail ? 'preview' : showClip ? 'clip' : 'tools'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.12 }}
        >
          {showPreviewRail ? (
            <PreviewRail onBack={() => setShowPreviewRail(false)} />
          ) : (
            <Rail tiles={tiles} onPreview={() => setShowPreviewRail(true)} />
          )}
        </m.div>
      </AnimatePresence>
    </nav>
  );
}
