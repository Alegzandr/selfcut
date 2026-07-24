import { useTranslation } from 'react-i18next';
import { PenTool } from 'lucide-react';
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
          command.checked ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-300'
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
          active ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-300'
        }`}
        disabled={!hasSelection}
        aria-pressed={active}
        onClick={() => useStore.getState().setPreviewTool(active ? 'select' : 'pen')}
      >
        <PenTool className="h-4 w-4" />
      </button>
    </Tooltip>
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
      <ToolButton command={commands['preview.resetView']} />
    </div>
  );
}
