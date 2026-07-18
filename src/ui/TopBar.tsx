import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileX2, FolderOpen } from 'lucide-react';
import { APP_NAME } from '../app/config';
import logoUrl from '../assets/logo.png';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { useIsCoarsePointer } from '../lib/device';
import { AspectRatio } from '../types';
import { useEditorCommands, type Command } from './commands';

const ASPECTS = [
  { value: '16:9', titleKey: 'topbar.aspect.16x9' },
  { value: '9:16', titleKey: 'topbar.aspect.9x16' },
  { value: '1:1', titleKey: 'topbar.aspect.1x1' },
  { value: '4:5', titleKey: 'topbar.aspect.4x5' },
] as const satisfies readonly { value: AspectRatio; titleKey: string }[];

/**
 * The desktop toolbar as ids into the shared command map, `'---'` being a
 * separator - the same convention as MENUS in MenuBar. Grouped for an editor's
 * reflexes: cut operations, insertions, then timeline view controls.
 * `'clip.link'` is a contextual slot that renders as unlink when the selection
 * is already a linked A/V pair.
 */
const DESKTOP_TOOLS = [
  'clip.split',
  'clip.rippleDelete',
  'clip.delete',
  'clip.link',
  'clip.punchIn',
  '---',
  'insert.text',
  'insert.marker',
  '---',
  'view.snap',
  'view.zoomOut',
  'view.zoomIn',
  'view.zoomFit',
] as const;

function ToolButton({
  command,
  label,
  hideShortcut,
}: {
  command: Command | undefined;
  /** Overrides the command's label in the tooltip (and accessible name). */
  label?: string;
  hideShortcut?: boolean;
}) {
  const { t } = useTranslation();
  const Icon = command?.icon;
  if (!command || !Icon) return null;
  return (
    <Tooltip label={label ?? t(command.labelKey)} shortcut={hideShortcut ? undefined : command.shortcut}>
      <button
        className={`touch-hit rounded-lg p-2 enabled:active:bg-zinc-800 disabled:opacity-30 ${
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
 * "New project" without a native confirm(): the first press arms the button
 * (it turns into an explicit red "Discard?"), a second press within 4s resets.
 * Touch only - on desktop the File menu owns "New project".
 */
function NewProjectButton() {
  const { t } = useTranslation();
  const { resetProject } = useStore.getState();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <Tooltip label={t('topbar.newProject.confirm')}>
        <button
          className="flex items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-300 active:bg-red-500/30"
          onClick={() => {
            setArmed(false);
            resetProject();
          }}
          onBlur={() => setArmed(false)}
        >
          <FileX2 className="h-4 w-4" />
          {t('topbar.newProject.armed')}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={t('topbar.newProject.title')}>
      <button
        className="touch-hit rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
        onClick={() => setArmed(true)}
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
        <div className="flex items-center gap-1.5 pr-1">
          <img src={logoUrl} alt="" className="h-6 w-6 select-none" draggable={false} />
          <span className="hidden text-sm font-bold tracking-wide text-zinc-100 sm:inline">
            {APP_NAME}
          </span>
        </div>
      )}

      {/* Editing / view tools. Touch keeps them in the bottom tool rail and
          touch gestures (pinch-to-zoom), so this group is desktop only. */}
      {!coarse &&
        DESKTOP_TOOLS.map((id, i) => {
          if (id === '---') return <div key={`sep-${i}`} className="mx-1 h-5 w-px bg-zinc-800" />;
          if (id === 'clip.link' && commands['clip.unlink']?.disabled === false) {
            return <ToolButton key={id} command={commands['clip.unlink']} />;
          }
          if (id === 'view.snap') {
            // The snapping strings carry their own "(N)" hint plus the
            // Shift-to-override tip, so skip the shortcut chip here.
            const snap = commands[id];
            return (
              <ToolButton
                key={id}
                command={snap}
                label={t(snap?.checked ? 'transport.snapping.on' : 'transport.snapping.off')}
                hideShortcut
              />
            );
          }
          return <ToolButton key={id} command={commands[id]} />;
        })}

      {/* Mobile: the media library lives in a drawer. */}
      {coarse && (
        <button
          className="touch-hit relative rounded-lg p-2 text-zinc-400 active:bg-zinc-800"
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
              className="absolute -right-0.5 -top-0.5 rounded-full bg-sky-500 px-1 text-[9px] font-bold leading-3.5 text-white"
            >
              {assetCount}
            </span>
          )}
        </button>
      )}

      <div className="mx-auto" />

      {/* New project + Export live in the File menu on desktop; touch has no menu
          bar, so keep them reachable here. */}
      {coarse && <NewProjectButton />}

      <ToolButton command={commands['edit.undo']} />
      <ToolButton command={commands['edit.redo']} />

      {coarse && (
        <Tooltip label={t('topbar.exportHint')} shortcut="Ctrl+E">
          <button
            className="touch-hit flex items-center gap-1.5 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-white active:bg-sky-600"
            onClick={() => setExportOpen(true)}
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t('topbar.export')}</span>
          </button>
        </Tooltip>
      )}

      {/* Aspect ratio picker, pinned to the far right. */}
      <div className="flex overflow-hidden rounded-lg border border-zinc-700">
        {ASPECTS.map(({ value, titleKey }) => (
          <Tooltip key={value} label={t(titleKey)}>
            <button
              className={`touch-hit px-2 py-1.5 text-xs tabular-nums ${aspectRatio === value ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 active:bg-zinc-800'}`}
              onClick={() => setAspectRatio(value)}
            >
              {value}
            </button>
          </Tooltip>
        ))}
      </div>
    </header>
  );
}
