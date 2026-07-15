import type { ComponentType } from 'react';
import type { ParseKeys } from 'i18next';
import {
  Blend,
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FileX2,
  Film,
  Flag,
  ListChecks,
  Music,
  Redo2,
  Repeat,
  Scissors,
  SkipBack,
  SlidersHorizontal,
  Square,
  StretchHorizontal,
  Type,
  Undo2,
  Keyboard,
  LayoutPanelTop,
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  Play,
  Magnet,
  MapPin,
  Settings,
  Info,
} from 'lucide-react';
import { useStore, getSelectedClip } from '../store/store';
import { useImport } from './useImport';
import { openMediaPicker } from './mediaPicker';
import { zoomAtPlayhead, zoomToFit } from '../timeline/zoom';

/**
 * A single editor action, resolved against the current store state. The desktop
 * menu bar and the mobile CapCut tool rails both consume this map, so a command
 * (its handler, its enabled/checked state, its shortcut hint) is described once.
 */
export interface Command {
  id: string;
  labelKey: ParseKeys;
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
  const loopEnabled = useStore((s) => s.loopEnabled);
  const selectedClip = useStore(getSelectedClip);
  // Stream layout only makes sense on a real media clip (not text/solid overlays).
  const canStream = selectedClip !== null && selectedClip.assetId !== '';

  const st = useStore.getState;

  const list: Command[] = [
    // ── File ──────────────────────────────────────────────────────────────
    { id: 'file.new', labelKey: 'menu.file.new', icon: FileX2, danger: true, onClick: () => st().resetProject() },
    { id: 'file.import', labelKey: 'menu.file.import', icon: FilePlus, onClick: () => openMediaPicker(importFiles) },
    { id: 'file.export', labelKey: 'menu.file.export', icon: Download, shortcut: 'Ctrl+E', onClick: () => st().setExportOpen(true) },

    // ── Edit ──────────────────────────────────────────────────────────────
    { id: 'edit.undo', labelKey: 'menu.edit.undo', icon: Undo2, shortcut: 'Ctrl+Z', disabled: !canUndo, onClick: () => st().undo() },
    { id: 'edit.redo', labelKey: 'menu.edit.redo', icon: Redo2, shortcut: 'Ctrl+Shift+Z', disabled: !canRedo, onClick: () => st().redo() },
    { id: 'edit.cut', labelKey: 'menu.edit.cut', icon: Scissors, shortcut: 'Ctrl+X', disabled: !selectedId, onClick: () => selectedId && st().cutClip(selectedId) },
    { id: 'edit.copy', labelKey: 'menu.edit.copy', icon: Copy, shortcut: 'Ctrl+C', disabled: !selectedId, onClick: () => selectedId && st().copyClip(selectedId) },
    { id: 'edit.paste', labelKey: 'menu.edit.paste', icon: ClipboardPaste, shortcut: 'Ctrl+V', disabled: !hasClipboard, onClick: () => st().pasteAtPlayhead() },
    { id: 'edit.selectAll', labelKey: 'menu.edit.selectAll', icon: ListChecks, shortcut: 'Ctrl+A', onClick: () => st().selectAllClips() },
    { id: 'edit.preferences', labelKey: 'menu.edit.preferences', icon: Settings, onClick: () => st().setPreferencesOpen(true) },

    // ── Insert ────────────────────────────────────────────────────────────
    { id: 'insert.text', labelKey: 'menu.insert.text', icon: Type, shortcut: 'T', onClick: () => st().addTextClip() },
    { id: 'insert.color', labelKey: 'menu.insert.color', icon: Square, onClick: () => st().addSolidClip('color') },
    { id: 'insert.gradient', labelKey: 'menu.insert.gradient', icon: Blend, onClick: () => st().addSolidClip('gradient') },
    { id: 'insert.videoTrack', labelKey: 'menu.insert.videoTrack', icon: Film, onClick: () => st().addTrack('video') },
    { id: 'insert.audioTrack', labelKey: 'menu.insert.audioTrack', icon: Music, onClick: () => st().addTrack('audio') },
    { id: 'insert.marker', labelKey: 'menu.insert.marker', icon: Flag, shortcut: 'M', onClick: () => st().addMarkerAtPlayhead() },

    // ── Clip ──────────────────────────────────────────────────────────────
    { id: 'clip.split', labelKey: 'menu.clip.split', icon: Scissors, shortcut: 'S', onClick: () => st().splitAtPlayhead() },
    { id: 'clip.duplicate', labelKey: 'menu.clip.duplicate', icon: CopyPlus, shortcut: 'Ctrl+D', disabled: !selectedId, onClick: () => selectedId && st().duplicateClip(selectedId) },
    { id: 'clip.punchIn', labelKey: 'menu.clip.punchIn', icon: ZoomIn, shortcut: 'P', onClick: () => st().punchZoomSelected() },
    { id: 'clip.stream', labelKey: 'menu.clip.stream', icon: LayoutPanelTop, disabled: !canStream, onClick: () => selectedId && st().applyStreamLayout(selectedId) },
    { id: 'clip.adjust', labelKey: 'menu.clip.adjust', icon: SlidersHorizontal, disabled: !selectedId, onClick: () => st().setInspectorOpen(true) },
    { id: 'clip.delete', labelKey: 'menu.clip.delete', icon: Scissors, shortcut: 'Del', danger: true, disabled: !hasSelection, onClick: () => st().deleteClips(st().selectedClipIds, false) },
    { id: 'clip.rippleDelete', labelKey: 'menu.clip.rippleDelete', icon: Scissors, shortcut: 'Shift+Del', danger: true, disabled: !hasSelection, onClick: () => st().deleteClips(st().selectedClipIds, true) },

    // ── View ──────────────────────────────────────────────────────────────
    { id: 'view.zoomIn', labelKey: 'menu.view.zoomIn', icon: ZoomIn, shortcut: '+', onClick: () => zoomAtPlayhead(1.25) },
    { id: 'view.zoomOut', labelKey: 'menu.view.zoomOut', icon: ZoomOut, shortcut: '−', onClick: () => zoomAtPlayhead(1 / 1.25) },
    { id: 'view.zoomFit', labelKey: 'menu.view.zoomFit', icon: StretchHorizontal, shortcut: 'Shift+Z', onClick: () => zoomToFit() },
    { id: 'view.snap', labelKey: 'menu.view.snap', icon: Magnet, shortcut: 'N', checked: snapEnabled, onClick: () => st().toggleSnap() },
    { id: 'view.shortcuts', labelKey: 'menu.view.shortcuts', icon: Keyboard, shortcut: '?', onClick: () => st().setShortcutsOpen(true) },

    // ── Playback ──────────────────────────────────────────────────────────
    { id: 'playback.playPause', labelKey: 'menu.playback.playPause', icon: Play, shortcut: 'Space', onClick: () => st().setPlaying(!st().playing) },
    { id: 'playback.start', labelKey: 'menu.playback.start', icon: SkipBack, shortcut: 'Home', onClick: () => st().seek(0) },
    { id: 'playback.loop', labelKey: 'menu.playback.loop', icon: Repeat, shortcut: 'Q', checked: loopEnabled, onClick: () => st().toggleLoopEnabled() },
    { id: 'playback.regionIn', labelKey: 'menu.playback.regionIn', icon: MapPin, shortcut: 'I', onClick: () => st().setRegionEdgeAtPlayhead('in') },
    { id: 'playback.regionOut', labelKey: 'menu.playback.regionOut', icon: MapPin, shortcut: 'O', onClick: () => st().setRegionEdgeAtPlayhead('out') },

    // ── Help ──────────────────────────────────────────────────────────────
    { id: 'help.shortcuts', labelKey: 'menu.help.shortcuts', icon: Keyboard, shortcut: '?', onClick: () => st().setShortcutsOpen(true) },
    { id: 'help.about', labelKey: 'menu.help.about', icon: Info, onClick: () => st().setAboutOpen(true) },
  ];

  return Object.fromEntries(list.map((c) => [c.id, c]));
}
