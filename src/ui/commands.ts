import type { ComponentType } from 'react';
import type { ParseKeys } from 'i18next';
import {
  ArchiveIcon,
  BlendingModeIcon,
  BookmarkIcon,
  CardStackIcon,
  CardStackPlusIcon,
  ChatBubbleIcon,
  CheckboxIcon,
  ClipboardIcon,
  CopyIcon,
  CursorArrowIcon,
  DiscIcon,
  DownloadIcon,
  DrawingPinIcon,
  EnterFullScreenIcon,
  FileIcon,
  FilePlusIcon,
  GearIcon,
  HandIcon,
  InfoCircledIcon,
  KeyboardIcon,
  Link2Icon,
  LinkBreak2Icon,
  LoopIcon,
  MagicWandIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  PinLeftIcon,
  PlayIcon,
  ReloadIcon,
  ResetIcon,
  ScissorsIcon,
  SewingPinIcon,
  SpeakerLoudIcon,
  SquareIcon,
  StackIcon,
  StarIcon,
  TargetIcon,
  TextIcon,
  TrackPreviousIcon,
  TrashIcon,
  UploadIcon,
  VideoIcon,
  ViewHorizontalIcon,
  ViewVerticalIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '@radix-ui/react-icons';
import { useStore, getSelectedClip, getLinkTargets } from '../store/store';
import type { LibraryTab } from '../store/editorState';
import { useImport } from './useImport';
import { openMediaPicker, openSubtitlePicker } from './mediaPicker';
import { openProject, saveProject } from './projectActions';
import { createNewProject, refreshProjects } from './projectLibraryActions';
import { unbindProjectFile } from '../lib/projectFile';
import { applyPresetToClips, exportClipPreset, importPreset } from './presetActions';
import { clipDisplayName } from './clipName';
import { t } from '../i18n';
import { zoomAtPlayhead } from '../timeline/zoom';
import { isViewReset } from '../preview/view';

/**
 * A single editor action, resolved against the current store state. The desktop
 * menu bar and the mobile CapCut tool rails both consume this map, so a command
 * (its handler, its enabled/checked state, its shortcut hint) is described once.
 */
export interface Command {
  id: string;
  labelKey: ParseKeys;
  /**
   * An already-translated label that wins over `labelKey`. For the few commands
   * whose text is interpolated (the shape tool names its armed primitive), so
   * every surface renders the same string without knowing the parameters.
   */
  label?: string;
  /**
   * A longer line for the toolbar tooltip: what the tool does, or how to
   * override it. Menus and lists keep showing `labelKey`, so a hint never turns
   * into a paragraph-wide menu row.
   */
  hintKey?: ParseKeys;
  icon?: ComponentType<{ className?: string }>;
  /** Display-only accelerator, e.g. "Ctrl+Z" - the real binding lives in useEditorHotkeys. */
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Toggle state: a checkmark replaces the icon when true. */
  checked?: boolean;
  danger?: boolean;
}

/**
 * Build the command map. Subscribes only to the primitive slices that drive
 * enabled/checked flags (never `currentTimeMs`), so an open menu does not
 * re-render 60×/s during playback.
 */
export function useEditorCommands(): Record<string, Command> {
  const importFiles = useImport();
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const selectedId = useStore((s) => s.selectedClipId);
  const hasSelection = useStore((s) => s.selectedClipIds.length > 0);
  const hasClipboard = useStore((s) => s.clipboard !== null);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const previewTool = useStore((s) => s.previewTool);
  // Subscribe to the boolean, not the view: panning must not re-render every menu.
  const previewFitted = useStore((s) => isViewReset(s.previewView));
  const loopEnabled = useStore((s) => s.loopEnabled);
  const selectedClip = useStore(getSelectedClip);
  // Stream layout only makes sense on a real media clip (not text/solid overlays).
  const canStream = selectedClip !== null && selectedClip.assetId !== '';
  const isLinked = selectedClip !== null && selectedClip.linkId != null;
  // Link is offered when the selection resolves to a joinable A/V pair (two
  // clips on opposite tracks, or one clip with an obvious partner from the same
  // source). Subscribe to the boolean only - the pair is resolved in onClick.
  const canLink = useStore((s) => getLinkTargets(s) !== null);
  const inspectorTab = useStore((s) => s.inspectorTab);
  const libraryTab = useStore((s) => s.libraryTab);

  const st = useStore.getState;

  /** Show a library bin: pick its tab, and on mobile raise the drawer holding it. */
  const showLibraryTab = (tab: LibraryTab) => {
    st().setLibraryTab(tab);
    st().setLibraryOpen(true);
  };

  /**
   * The cue list is a pane of the inspector column, so showing it means picking
   * its tab - and on mobile also opening the sheet, which is otherwise only
   * raised by selecting a clip.
   */
  const toggleSubtitlesPane = () => {
    const showing = st().inspectorTab === 'subtitles';
    st().setInspectorTab(showing ? 'clip' : 'subtitles');
    st().setInspectorOpen(!showing);
  };

  const list: Command[] = [
    // ── File ──────────────────────────────────────────────────────────────
    {
      id: 'file.new',
      labelKey: 'menu.file.new',
      icon: FileIcon,
      // Multi-project: a new project no longer throws the old one away — it opens
      // a fresh untitled project alongside it, and the old one stays in the
      // browser. The new project is not tied to any `.selfcut` file yet.
      onClick: () => {
        void createNewProject().then(() => unbindProjectFile());
      },
    },
    { id: 'file.open', labelKey: 'menu.file.open', icon: ArchiveIcon, shortcut: 'Ctrl+O', onClick: () => openProject() },
    {
      id: 'file.projects',
      labelKey: 'menu.file.projects',
      icon: StackIcon,
      onClick: () => {
        st().setProjectLibraryOpen(true);
        void refreshProjects();
      },
    },
    { id: 'file.save', labelKey: 'menu.file.save', icon: DiscIcon, shortcut: 'Ctrl+S', onClick: () => saveProject(false) },
    { id: 'file.saveAs', labelKey: 'menu.file.saveAs', icon: CardStackIcon, shortcut: 'Ctrl+Shift+S', onClick: () => saveProject(true) },
    { id: 'file.import', labelKey: 'menu.file.import', icon: FilePlusIcon, onClick: () => openMediaPicker(importFiles) },
    // Its own entry rather than a note under Import: dropping an .srt on the
    // window has always worked, but nothing on screen ever said so.
    { id: 'file.importSubtitles', labelKey: 'menu.file.importSubtitles', hintKey: 'menu.file.importSubtitles.hint', icon: ChatBubbleIcon, onClick: () => openSubtitlePicker(importFiles) },
    // Presets are files like a project or a render is, so they belong with the
    // other file actions rather than tucked inside the panel that happens to
    // edit the look. Import both shelves and applies: the file dialog is the
    // expensive part, and it would be odd to pick a preset and see nothing move.
    {
      id: 'file.importPreset',
      labelKey: 'menu.file.importPreset',
      icon: UploadIcon,
      onClick: () =>
        importPreset((presetName, look) => {
          st().addLoadedPreset(presetName, look);
          if (st().selectedClipIds.length > 0) applyPresetToClips(look, st().selectedClipIds);
        }),
    },
    {
      id: 'file.savePreset',
      labelKey: 'menu.file.savePreset',
      icon: StarIcon,
      disabled: selectedClip === null,
      // Called straight from the click: the save picker needs transient user
      // activation, which would be gone after an await.
      onClick: () => {
        const clip = getSelectedClip(st());
        if (!clip) return;
        exportClipPreset(clip.id, clipDisplayName(clip, st().assets[clip.assetId], t));
      },
    },
    { id: 'file.export', labelKey: 'menu.file.export', icon: DownloadIcon, shortcut: 'Ctrl+E', onClick: () => st().setExportOpen(true) },

    // ── Edit ──────────────────────────────────────────────────────────────
    { id: 'edit.undo', labelKey: 'menu.edit.undo', icon: ResetIcon, shortcut: 'Ctrl+Z', disabled: !canUndo, onClick: () => st().undo() },
    { id: 'edit.redo', labelKey: 'menu.edit.redo', icon: ReloadIcon, shortcut: 'Ctrl+Shift+Z', disabled: !canRedo, onClick: () => st().redo() },
    { id: 'edit.cut', labelKey: 'menu.edit.cut', icon: ScissorsIcon, shortcut: 'Ctrl+X', disabled: !hasSelection, onClick: () => st().cutClips(st().selectedClipIds) },
    { id: 'edit.copy', labelKey: 'menu.edit.copy', icon: CopyIcon, shortcut: 'Ctrl+C', disabled: !hasSelection, onClick: () => st().copyClips(st().selectedClipIds) },
    { id: 'edit.paste', labelKey: 'menu.edit.paste', icon: ClipboardIcon, shortcut: 'Ctrl+V', disabled: !hasClipboard, onClick: () => st().pasteAtPlayhead() },
    { id: 'edit.selectAll', labelKey: 'menu.edit.selectAll', icon: CheckboxIcon, shortcut: 'Ctrl+A', onClick: () => st().selectAllClips() },
    { id: 'edit.preferences', labelKey: 'menu.edit.preferences', icon: GearIcon, onClick: () => st().setPreferencesOpen(true) },

    // ── Insert ────────────────────────────────────────────────────────────
    { id: 'insert.text', labelKey: 'menu.insert.text', icon: TextIcon, shortcut: 'T', onClick: () => st().addTextClip() },
    { id: 'insert.color', labelKey: 'menu.insert.color', icon: SquareIcon, onClick: () => st().addSolidClip('color') },
    { id: 'insert.gradient', labelKey: 'menu.insert.gradient', icon: BlendingModeIcon, onClick: () => st().addSolidClip('gradient') },
    { id: 'insert.videoTrack', labelKey: 'menu.insert.videoTrack', icon: VideoIcon, onClick: () => st().addTrack('video') },
    { id: 'insert.audioTrack', labelKey: 'menu.insert.audioTrack', icon: SpeakerLoudIcon, onClick: () => st().addTrack('audio') },
    { id: 'insert.marker', labelKey: 'menu.insert.marker', icon: BookmarkIcon, shortcut: 'M', onClick: () => st().addMarkerAtPlayhead() },

    // ── Clip ──────────────────────────────────────────────────────────────
    { id: 'clip.split', labelKey: 'menu.clip.split', icon: ViewVerticalIcon, shortcut: 'S', onClick: () => st().splitAtPlayhead() },
    // C (Premiere) and B (Resolve) also split - see useEditorHotkeys. Only S is
    // advertised here: a menu row listing three keys reads as a puzzle.
    { id: 'clip.duplicate', labelKey: 'menu.clip.duplicate', icon: CardStackPlusIcon, shortcut: 'Ctrl+D', disabled: !hasSelection, onClick: () => st().duplicateClips(st().selectedClipIds) },
    { id: 'clip.punchIn', labelKey: 'menu.clip.punchIn', icon: TargetIcon, shortcut: 'P', disabled: !selectedId, onClick: () => st().punchZoomSelected() },
    { id: 'clip.stream', labelKey: 'menu.clip.stream', icon: ViewHorizontalIcon, disabled: !canStream, onClick: () => selectedId && st().applyStreamLayout(selectedId) },
    { id: 'clip.adjust', labelKey: 'menu.clip.adjust', icon: MixerHorizontalIcon, disabled: !selectedId, onClick: () => st().setInspectorOpen(true) },
    { id: 'clip.link', labelKey: 'menu.clip.link', icon: Link2Icon, disabled: !canLink, onClick: () => { const targets = getLinkTargets(st()); if (targets) st().linkClips(targets); } },
    { id: 'clip.unlink', labelKey: 'menu.clip.unlink', icon: LinkBreak2Icon, disabled: !isLinked, onClick: () => selectedId && st().unlinkClip(selectedId) },
    { id: 'clip.delete', labelKey: 'menu.clip.delete', icon: TrashIcon, shortcut: 'Del', danger: true, disabled: !hasSelection, onClick: () => st().deleteClips(st().selectedClipIds, false) },
    { id: 'clip.rippleDelete', labelKey: 'menu.clip.rippleDelete', icon: PinLeftIcon, shortcut: 'Shift+Del', danger: true, disabled: !hasSelection, onClick: () => st().deleteClips(st().selectedClipIds, true) },

    // ── Preview tools ─────────────────────────────────────────────────────
    // Modes of the preview surface, not one-shot actions: exactly one is always
    // active, so they read as a radio group (`checked` lights the pressed one).
    { id: 'preview.toolSelect', labelKey: 'preview.tool.select', icon: CursorArrowIcon, shortcut: 'V', checked: previewTool === 'select', onClick: () => st().setPreviewTool('select') },
    { id: 'preview.toolHand', labelKey: 'preview.tool.hand.name', hintKey: 'preview.tool.hand', icon: HandIcon, shortcut: 'H', checked: previewTool === 'hand', onClick: () => st().setPreviewTool('hand') },
    { id: 'preview.toolZoom', labelKey: 'preview.tool.zoom.name', hintKey: 'preview.tool.zoom', icon: MagnifyingGlassIcon, shortcut: 'Z', checked: previewTool === 'zoom', onClick: () => st().setPreviewTool('zoom') },
    { id: 'preview.resetView', labelKey: 'preview.view.reset', icon: EnterFullScreenIcon, disabled: previewFitted, onClick: () => st().resetPreviewView() },

    // ── View ──────────────────────────────────────────────────────────────
    { id: 'view.zoomIn', labelKey: 'menu.view.zoomIn', icon: ZoomInIcon, shortcut: '+', onClick: () => zoomAtPlayhead(1.25) },
    { id: 'view.zoomOut', labelKey: 'menu.view.zoomOut', icon: ZoomOutIcon, shortcut: '−', onClick: () => zoomAtPlayhead(1 / 1.25) },
    { id: 'view.subtitles', labelKey: 'menu.view.subtitles', icon: ChatBubbleIcon, checked: inspectorTab === 'subtitles', onClick: () => toggleSubtitlesPane() },
    // The library's three bins. Desktop docks the column permanently, so these
    // only pick a tab; on mobile they also raise the drawer that holds it.
    { id: 'view.media', labelKey: 'menu.view.media', icon: ArchiveIcon, checked: libraryTab === 'media', onClick: () => showLibraryTab('media') },
    { id: 'view.effects', labelKey: 'menu.view.effects', icon: MagicWandIcon, checked: libraryTab === 'effects', onClick: () => showLibraryTab('effects') },
    { id: 'view.transitions', labelKey: 'menu.view.transitions', icon: BlendingModeIcon, checked: libraryTab === 'transitions', onClick: () => showLibraryTab('transitions') },
    { id: 'view.snap', labelKey: 'menu.view.snap', hintKey: snapEnabled ? 'transport.snapping.on' : 'transport.snapping.off', icon: DrawingPinIcon, shortcut: 'N', checked: snapEnabled, onClick: () => st().toggleSnap() },

    // ── Playback ──────────────────────────────────────────────────────────
    { id: 'playback.playPause', labelKey: 'menu.playback.playPause', icon: PlayIcon, shortcut: 'Space', onClick: () => st().setPlaying(!st().playing) },
    { id: 'playback.start', labelKey: 'menu.playback.start', icon: TrackPreviousIcon, shortcut: 'Home', onClick: () => st().seek(0) },
    { id: 'playback.loop', labelKey: 'menu.playback.loop', icon: LoopIcon, shortcut: 'Q', checked: loopEnabled, onClick: () => st().toggleLoopEnabled() },
    { id: 'playback.regionIn', labelKey: 'menu.playback.regionIn', icon: SewingPinIcon, shortcut: 'I', onClick: () => st().setRegionEdgeAtPlayhead('in') },
    { id: 'playback.regionOut', labelKey: 'menu.playback.regionOut', icon: SewingPinIcon, shortcut: 'O', onClick: () => st().setRegionEdgeAtPlayhead('out') },

    // ── Help ──────────────────────────────────────────────────────────────
    { id: 'help.shortcuts', labelKey: 'menu.help.shortcuts', icon: KeyboardIcon, shortcut: '?', onClick: () => st().setShortcutsOpen(true) },
    { id: 'help.about', labelKey: 'menu.help.about', icon: InfoCircledIcon, onClick: () => st().setAboutOpen(true) },
  ];

  return Object.fromEntries(list.map((c) => [c.id, c]));
}
