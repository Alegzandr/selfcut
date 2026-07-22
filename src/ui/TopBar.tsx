import { useTranslation } from 'react-i18next';
import { Download, FileX2, FolderOpen } from 'lucide-react';
import { APP_NAME } from '../app/config';
import logoUrl from '../assets/logo.png';
import { useStore } from '../store/store';
import { unbindProjectFile } from '../lib/projectFile';
import { confirmDiscardProject } from './projectActions';
import { Tooltip } from './Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { AspectRatio } from '../types';
import { useEditorCommands, type Command } from './commands';
import { useToolbarOverflow } from './useToolbarOverflow';
import { ToolOverflowMenu } from './ToolOverflowMenu';
import type { MenuEntry } from './menu/MenuList';

const ASPECTS = [
  { value: '16:9', titleKey: 'topbar.aspect.16x9' },
  { value: '9:16', titleKey: 'topbar.aspect.9x16' },
  { value: '1:1', titleKey: 'topbar.aspect.1x1' },
  { value: '4:5', titleKey: 'topbar.aspect.4x5' },
] as const satisfies readonly { value: AspectRatio; titleKey: string }[];

/**
 * The desktop toolbar as ids into the shared command map, one inner array per
 * separated group - the same commands MENUS in MenuBar draws from.
 *
 * This bar holds *editing* actions only, and only the ones worth a permanent
 * button. Deliberately absent:
 *
 * - File actions (new / open / save / save as). They are one Ctrl-key away and
 *   live in the File menu; nobody saves a cut by aiming at a toolbar. Export is
 *   the exception and gets its own pinned button on the right.
 * - The clipboard (cut / copy / paste). Ctrl+X/C/V is universal, and a toolbar
 *   button for it is a 1997 word-processor reflex, not an editor's.
 * - `clip.delete` next to `clip.rippleDelete`: two adjacent bins with opposite
 *   consequences is a trap. Ripple delete is the cut-room default and stays;
 *   plain delete keeps the Clip menu, the context menu and Del.
 * - Preview tools, which now float on the monitor they steer (PreviewToolbar),
 *   and timeline zoom/snapping, which sit at the right end of the transport,
 *   directly above the timeline they steer.
 *
 * The order doubles as the priority order: when the bar runs out of width,
 * groups fold into the overflow menu from the tail. `'clip.link'` is a
 * contextual slot that renders as unlink when the selection is already a
 * linked A/V pair.
 *
 * Speed, crop and transform are intentionally absent: on desktop the inspector
 * is a docked column that appears the moment a clip is selected, so those
 * controls are always one click away and need no toolbar button.
 */
const DESKTOP_TOOL_GROUPS = [
  ['clip.split', 'clip.duplicate', 'clip.rippleDelete', 'clip.link'],
  ['clip.punchIn', 'clip.stream'],
  ['insert.text', 'insert.marker'],
] as const;

type Commands = ReturnType<typeof useEditorCommands>;

/**
 * A toolbar slot to the command it stands for right now. Resolving to a whole
 * command (rather than overriding props on the button) is what lets a tool keep
 * the same label, icon and shortcut hint once it moves into the overflow menu.
 */
function resolveTool(id: string, commands: Commands): Command | undefined {
  if (id === 'clip.link' && commands['clip.unlink']?.disabled === false) {
    return commands['clip.unlink'];
  }
  return commands[id];
}

function ToolButton({ command }: { command: Command | undefined }) {
  const { t } = useTranslation();
  const Icon = command?.icon;
  if (!command || !Icon) return null;
  return (
    // The tooltip has room for the long form; the overflow menu shows the name.
    <Tooltip
      label={command.hintKey ? t(command.hintKey) : (command.label ?? t(command.labelKey))}
      shortcut={command.shortcut}
    >
      <button
        className={`touch-hit rounded-lg p-2 enabled:hover:bg-zinc-800/70 enabled:hover:bg-zinc-800/70 active:bg-zinc-800 disabled:opacity-30 ${
          command.checked ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400'
        }`}
        disabled={command.disabled}
        aria-pressed={command.checked}
        onClick={command.onClick}
      >
        <Icon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

/**
 * Editing / view tools. Touch keeps them in the bottom tool rail and in touch
 * gestures (pinch-to-zoom), so this row is desktop only.
 *
 * It takes the free width of the bar and hands whatever no longer fits to an
 * overflow menu, rather than wrapping to a second line: vertical space belongs
 * to the timeline and the monitor, and a bar that changes height on resize
 * moves every panel below it. Groups fold whole, so the muscle memory of "the
 * clipboard is the second cluster" holds at every width.
 */
function DesktopTools() {
  const commands = useEditorCommands();
  const groups = DESKTOP_TOOL_GROUPS.map((ids) =>
    ids
      .map((id): { id: string; command: Command | undefined } => ({
        id,
        command: resolveTool(id, commands),
      }))
      .filter((slot): slot is { id: string; command: Command } => !!slot.command?.icon),
  );
  const { rowRef, visibleCount } = useToolbarOverflow(groups.length);

  const folded: MenuEntry[] = groups
    .slice(visibleCount)
    .flatMap((group, i) => [...(i > 0 ? (['---'] as const) : []), ...group.map((s) => s.command)]);

  return (
    // No `overflow-hidden`: the trimming runs in a layout effect and in a
    // ResizeObserver callback, both of which land before the frame is painted,
    // and clipping the row would swallow the overflow menu's panel.
    <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-1">
      {groups.slice(0, visibleCount).map((group, i) => (
        <div
          key={DESKTOP_TOOL_GROUPS[i]![0]}
          data-tool-group
          className="flex flex-none items-center gap-1"
        >
          {/* Leading rather than trailing, so the group carries its own divider
              into the width measurement and none is ever left dangling. */}
          {i > 0 && <div className="h-5 w-px bg-zinc-800" />}
          {group.map(({ id, command }) => (
            <ToolButton key={id} command={command} />
          ))}
        </div>
      ))}
      {folded.length > 0 && <ToolOverflowMenu entries={folded} />}
    </div>
  );
}

/**
 * "New project" on touch - on desktop the File menu owns it. Both go through
 * the same confirmation dialog, so the two entry points cannot disagree about
 * what discarding a project takes.
 */
function NewProjectButton() {
  const { t } = useTranslation();
  const { resetProject } = useStore.getState();

  return (
    <Tooltip label={t('topbar.newProject.title')}>
      <button
        className="touch-hit rounded-lg p-2 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
        onClick={() => {
          void confirmDiscardProject().then((ok) => {
            if (!ok) return;
            resetProject();
            // Same contract as File ▸ New: the fresh project is not the file the
            // old one came from, so a later Ctrl+S must ask where to go rather
            // than silently overwrite it.
            unbindProjectFile();
          });
        }}
      >
        <FileX2 className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  const aspectRatio = useStore((s) => s.project.aspectRatio);
  const assetCount = useStore((s) => Object.keys(s.assets).length);
  const coarse = useIsCoarsePointer();
  const { setAspectRatio, setExportOpen, setLibraryOpen } = useStore.getState();

  return (
    <header className="flex h-12 flex-none items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 sm:gap-2 sm:px-3">
      {/* Desktop shows the logo/name in the menu bar above; only mobile
          (which has no menu bar) needs the branding here. */}
      {coarse && (
        <div className="flex flex-none items-center gap-1.5 pr-1">
          <img src={logoUrl} alt="" className="h-6 w-6 select-none" draggable={false} />
          <span className="hidden text-sm font-bold tracking-wide text-zinc-100 sm:inline">
            {APP_NAME}
          </span>
        </div>
      )}

      {!coarse && <DesktopTools />}

      {/* Mobile: the media library lives in a drawer. */}
      {coarse && (
        <button
          className="touch-hit relative flex-none rounded-lg p-2 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
          onClick={() => setLibraryOpen(true)}
          // aria-label, not title: with a title alone the badge text becomes
          // the accessible name (a screen reader hears "3" for this button).
          aria-label={t('topbar.library')}
          title={t('topbar.library')}
        >
          <FolderOpen className="h-4 w-4" />
          {assetCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 rounded-full bg-sky-500 px-1 text-4xs font-bold leading-3.5 text-white"
            >
              {assetCount}
            </span>
          )}
        </button>
      )}

      {/* On desktop the tool row is flex-1 and has already taken the slack. */}
      {coarse && <div className="ml-auto" />}

      {/* Pinned to the far right and never folded: undo and the export target
          have to sit in the same place at every window width. */}
      <div className="flex flex-none items-center gap-1 sm:gap-2">
        {/* Desktop has File ▸ New in the menu bar; touch has no menu bar, so it
            needs its own (arm-then-confirm) button here. */}
        {coarse && <NewProjectButton />}

        <ToolButton command={commands['edit.undo']} />
        <ToolButton command={commands['edit.redo']} />

        {/* The one action the whole session builds towards: a fixed, named
            target on every device, not an icon among twenty in the tool row. */}
        <Tooltip label={t('topbar.exportHint')} shortcut="Ctrl+E">
          <button
            className="touch-hit flex items-center gap-1.5 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-400 active:bg-sky-600"
            onClick={() => setExportOpen(true)}
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t('topbar.export')}</span>
          </button>
        </Tooltip>

        <div className="flex overflow-hidden rounded-lg border border-zinc-700">
          {ASPECTS.map(({ value, titleKey }) => (
            <Tooltip key={value} label={t(titleKey)}>
              <button
                className={`touch-hit px-2 py-1.5 text-xs tabular-nums ${aspectRatio === value ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800'}`}
                onClick={() => setAspectRatio(value)}
              >
                {value}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    </header>
  );
}
