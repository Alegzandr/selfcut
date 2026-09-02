import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { GridIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { MenuList, type MenuEntry } from '../ui/menu/MenuList';
import { MenuPanel, useDismissOnOutside } from '../ui/menu/MenuPanel';
import { PREVIEW_GUIDE_MODES } from './guides';
import { useEditorCommands, type Command } from '../ui/commands';
import { ShapeToolButton } from '../ui/ShapeToolButton';
import { Tooltip } from '../ui/Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { useStore } from '../store/store';

/**
 * Tools that act on the monitor: the select / hand / zoom modes, the shape tool,
 * and "fit the view back". They sit on the monitor rather than in the top bar
 * because that is what they steer - a camera control two panels away from the
 * camera is a control you have to hunt for.
 *
 * Floating over the canvas (like the resolution picker in the opposite corner)
 * rather than taking a row of its own: vertical space belongs to the monitor and
 * the timeline.
 *
 * Desktop only. Touch drives the preview with direct gestures (drag to pan,
 * pinch to zoom), so a mode switcher would be a rail of buttons nobody presses.
 */
const TOOL_IDS = ['preview.toolSelect', 'preview.toolHand', 'preview.toolZoom'] as const;

function ToolButton({ command }: { command: Command | undefined }) {
  const { t } = useTranslation();
  const Icon = command?.icon;
  if (!command || !Icon) return null;
  return (
    <Tooltip
      label={command.hintKey ? t(command.hintKey) : (command.label ?? t(command.labelKey))}
      shortcut={command.shortcut}
    >
      <button
        className={`touch-hit rounded-md p-1.5 enabled:hover:bg-zinc-800/80 disabled:opacity-30 ${
          command.checked ? 'brand-on' : 'text-zinc-300'
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
 * Pen tool: draws / edits a bezier mask on the selected clip. Its own button
 * (not a `Command`) because it toggles a preview mode and has no menu entry.
 * Disabled with nothing selected, since a mask has to belong to a clip.
 */
function PenToolButton() {
  const { t } = useTranslation();
  const active = useStore((s) => s.previewTool === 'pen');
  const hasSelection = useStore((s) => s.selectedClipId !== null);
  return (
    <Tooltip label={t('preview.tool.pen.name')}>
      <button
        className={`touch-hit rounded-md p-1.5 enabled:hover:bg-zinc-800/80 disabled:opacity-30 ${
          active ? 'brand-on' : 'text-zinc-300'
        }`}
        disabled={!hasSelection}
        aria-pressed={active}
        onClick={() => useStore.getState().setPreviewTool(active ? 'select' : 'pen')}
      >
        <Pencil1Icon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

/**
 * Guide overlays (safe margins, thirds, the platform's chrome). A menu rather
 * than a cycling button: four states are too many to step through blindly,
 * and the open list says which one is on. Lit while any overlay is showing.
 */
function GuidesMenuButton({ commands }: { commands: Record<string, Command> }) {
  const { t } = useTranslation();
  const mode = useStore((s) => s.previewGuides);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, () => setOpen(false), rootRef);
  const entries: MenuEntry[] = PREVIEW_GUIDE_MODES.map((m) => commands[`view.guides.${m}`]).filter(
    (c): c is Command => !!c,
  );
  return (
    <div ref={rootRef} className="relative">
      <Tooltip label={t('preview.guides')} disabled={open}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('preview.guides')}
          className={`touch-hit rounded-md p-1.5 enabled:hover:bg-zinc-800/80 ${
            mode !== 'off' ? 'brand-on' : 'text-zinc-300'
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          <GridIcon className="h-4 w-4" />
        </button>
      </Tooltip>
      <AnimatePresence>
        {open && (
          <MenuPanel className="left-0 top-full mt-1 min-w-44">
            <MenuList items={entries} onRun={() => setOpen(false)} />
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PreviewToolbar() {
  const commands = useEditorCommands();
  const coarse = useIsCoarsePointer();
  if (coarse) return null;

  return (
    <div className="absolute left-2 top-2 z-20 flex items-center gap-0.5 rounded-lg border border-zinc-700/70 bg-zinc-900/70 p-0.5 backdrop-blur">
      {TOOL_IDS.map((id) => (
        <ToolButton key={id} command={commands[id]} />
      ))}
      <ShapeToolButton />
      <PenToolButton />
      <div className="mx-0.5 h-5 w-px bg-zinc-700/70" />
      <GuidesMenuButton commands={commands} />
      <ToolButton command={commands['preview.resetView']} />
    </div>
  );
}
