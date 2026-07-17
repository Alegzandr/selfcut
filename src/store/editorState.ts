import {
  Clip,
  LoopRegion,
  MediaAsset,
  Project,
  Track,
  AspectRatio,
} from '../types';
import type { TimeFormat } from '../lib/time';
import type { PreviewResolutionMode } from '../app/config';

export interface ClipboardEntry {
  clip: Clip;
  kind: Track['kind'];
}

/**
 * What the user right-clicked, so the shared `<ContextMenu>` can build the right
 * item list. Only the target's identity is stored (never closures) - the menu
 * resolves live commands from it at render, keeping enabled/checked flags fresh.
 */
export type ContextTarget =
  | { kind: 'clip'; clipId: string }
  | { kind: 'timeline' }
  | { kind: 'marker'; markerId: string }
  | { kind: 'track'; trackId: string }
  | { kind: 'asset'; assetId: string };

export interface ContextMenuState {
  /** Viewport coordinates of the click (the menu anchors here, flipping at edges). */
  x: number;
  y: number;
  target: ContextTarget;
}

export interface EditorState {
  project: Project;
  assets: Record<string, MediaAsset>;
  /** Primary selection (last clicked) - the one the inspector edits. */
  selectedClipId: string | null;
  /** Full selection (multi-select via Ctrl/Cmd+click on desktop). */
  selectedClipIds: string[];
  currentTimeMs: number;
  /** Incremented on every user seek - the playback engine resyncs to it. */
  seekVersion: number;
  playing: boolean;
  /** Timeline selection (yellow corners): loop range and optional export range. */
  loopRegion: LoopRegion | null;
  /** Whether playback loops inside the region. */
  loopEnabled: boolean;
  /** Shuttle rate (J/K/L): 1 = normal. Reset to 1 whenever playback stops. */
  playbackRate: number;
  pxPerSec: number;
  /** Left padding of the timeline content in px (half the viewport on mobile, fixed on desktop). */
  timelinePadLeft: number;
  /** Clip-drag snapping (N toggles it; Shift inverts it for the current drag). */
  snapEnabled: boolean;
  /** Timeline time (ms) a drag is currently snapped to - drawn as a guide line. */
  snapGuideMs: number | null;
  /**
   * Floating readout of the in-flight drag (position/duration/offset + delta),
   * keyed to the edited clip. Lives in the store - not in the clip's component -
   * so it survives the remount when a drag crosses onto another track.
   */
  dragBadge: { clipId: string; text: string } | null;
  /** Mobile only: the inspector opens on demand (Adjust button), not on every selection. */
  inspectorOpen: boolean;
  /** Mobile only: the media library lives in a drawer (desktop docks it permanently). */
  libraryOpen: boolean;
  shortcutsOpen: boolean;
  /** Preferences dialog (language, time format). */
  preferencesOpen: boolean;
  /** About dialog (app name, version). */
  aboutOpen: boolean;
  /** Open right-click menu (desktop), or null when none is showing. */
  contextMenu: ContextMenuState | null;
  /** Marker whose inline label editor is open (opened by dbl-click or the menu). */
  renamingMarkerId: string | null;
  /** How the transport spells time out (persisted). */
  timeFormat: TimeFormat;
  /** Preview playback resolution the user picked (persisted). */
  previewResolution: PreviewResolutionMode;
  clipboard: ClipboardEntry | null;
  exportOpen: boolean;
  importing: boolean;
  error: string | null;

  past: Project[];
  future: Project[];
  gestureSnapshot: Project | null;

  setAspectRatio: (a: AspectRatio) => void;
  addAsset: (asset: MediaAsset) => void;
  removeAsset: (assetId: string) => void;
  /**
   * Re-probe a user-chosen file for an asset whose persisted File went stale
   * (see `MediaAsset.disconnected`), keeping the asset id so its clips reconnect.
   */
  reconnectAsset: (assetId: string, file: File) => Promise<void>;
  addClipFromAsset: (assetId: string) => void;
  /** Drop an asset at a specific timeline position (drag from the media library). */
  addClipFromAssetAt: (assetId: string, timelineMs: number, targetTrackId?: string) => void;
  /** Insert a generated text clip at the playhead, on a free topmost video track. */
  addTextClip: () => void;
  /** Insert a generated full-frame colour or gradient clip at the playhead. */
  addSolidClip: (kind: 'color' | 'gradient') => void;
  addTrack: (kind: Track['kind']) => void;
  /** Live track edit (volume/opacity slider drags) - wrap with begin/endGesture. */
  updateTrack: (trackId: string, patch: Partial<Track>) => void;
  removeTrack: (trackId: string) => void;
  moveTrack: (trackId: string, dir: -1 | 1) => void;
  toggleTrackMuted: (trackId: string) => void;
  toggleTrackHidden: (trackId: string) => void;

  setAssetPeaks: (assetId: string, audioTrackIndex: number, peaks: number[]) => void;
  setAssetThumbnails: (assetId: string, thumbnails: string[]) => void;

  selectClip: (id: string | null) => void;
  /** Ctrl/Cmd+A: every clip on every track. */
  selectAllClips: () => void;
  /** Ctrl/Cmd+click: add/remove a clip from the multi-selection. */
  toggleSelectClip: (id: string) => void;
  /** Replace the whole selection (marquee / rubber-band select). */
  setSelectedClips: (ids: string[]) => void;
  /**
   * Shift+click: select every clip in the rectangle spanned by the anchor
   * (primary selection) and the target - rows between them, anchor→target time span.
   */
  selectClipRange: (anchorId: string, targetId: string) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  updateClipCommitted: (clipId: string, patch: Partial<Clip>) => void;
  moveClip: (clipId: string, timelineStartMs: number, targetTrackId?: string) => void;
  /** Batch position update (multi-selection drag), no history - wrap with begin/endGesture. */
  moveClips: (entries: { clipId: string; timelineStartMs: number }[]) => void;
  trimClip: (clipId: string, edge: 'left' | 'right', timelineMs: number) => void;
  /**
   * Slip edit (Alt+drag on a clip body): slide the source window while the
   * clip's timeline position and duration stay fixed. Live - wrap with
   * begin/endGesture. Linked partners slip in lockstep.
   */
  slipClip: (clipId: string, sourceInMs: number) => void;
  /**
   * Ctrl+drag copy: clone the given clips (and their linked partners, re-paired
   * under fresh linkIds) in place, select the clones, and return the
   * original→clone id map so the drag can move the clones. No history: the
   * surrounding gesture commits clone+move as one undo step.
   */
  cloneClipsForDrag: (clipIds: string[]) => Record<string, string>;
  splitAtPlayhead: () => void;
  deleteClip: (clipId: string) => void;
  /** Delete a clip and close the gap: later clips on the same track shift left. */
  rippleDeleteClip: (clipId: string) => void;
  /** Delete several clips as one undo step; ripple closes the gaps. */
  deleteClips: (clipIds: string[], ripple: boolean) => void;
  duplicateClip: (clipId: string) => void;
  /**
   * Break an A/V link: the video and audio clips become independent (they no
   * longer move/trim/split/delete together). The audio keeps playing from the
   * audio clip; the video side is muted (volume 0) so the sound is not doubled.
   */
  unlinkClip: (clipId: string) => void;
  /**
   * Re-link clips into one A/V pair (fresh shared `linkId`) so they move, trim,
   * split and delete together again. The video side is muted in the mix by the
   * link itself, so its audio is delegated to the audio clip (never doubled).
   * The UI resolves the target ids from the selection via `linkableSelection`.
   */
  linkClips: (clipIds: string[]) => void;
  copyClip: (clipId: string) => void;
  cutClip: (clipId: string) => void;
  pasteAtPlayhead: () => void;
  /**
   * Punch-in zoom (the social-cut staple): cycle the scale of the selected
   * clip - or the topmost video clip under the playhead - 1 → 1.2 → 1.4 → 1.
   */
  punchZoomSelected: () => void;
  toggleSnap: () => void;
  /**
   * Import parsed subtitle cues as caption clips (outlined, lower-third) on a
   * dedicated topmost video track, one undo step for the whole file.
   */
  addSubtitleClips: (cues: { startMs: number; endMs: number; text: string }[]) => void;
  /**
   * Stream-clip layout: split the selected clip into a facecam band (top 30%,
   * cropped to the source's top-left corner by default) over a gameplay band
   * (bottom 70%, center crop). The duplicate lands on a track above; both
   * crops are then adjustable per clip (crop edit mode).
   */
  applyStreamLayout: (clipId: string) => void;
  /** Preview crop-edit mode for the selected video clip (session state). */
  cropEditing: boolean;
  setCropEditing: (v: boolean) => void;

  beginGesture: () => void;
  endGesture: () => void;
  /** Escape during a drag: restore the pre-gesture project and drop the snapshot. */
  cancelGesture: () => void;
  undo: () => void;
  redo: () => void;
  /** Publish/clear the snap guide line while a drag is snapped to a point. */
  setSnapGuide: (ms: number | null) => void;
  /** Publish/clear the floating drag readout for a clip. */
  setDragBadge: (badge: { clipId: string; text: string } | null) => void;

  seek: (ms: number) => void;
  setCurrentTimeFromEngine: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  setPlaybackRate: (rate: number) => void;

  /** Live during a drag on the region bar; a span shorter than MIN_REGION_MS clears it. */
  setLoopRegion: (region: LoopRegion | null) => void;
  /** I / O keys: pull one edge of the region to the playhead (creating it if needed). */
  setRegionEdgeAtPlayhead: (edge: 'in' | 'out') => void;
  toggleLoopEnabled: () => void;

  /** Drop a marker at the playhead (no-op if one already sits there). */
  addMarkerAtPlayhead: () => void;
  /** Live marker drag - wrap with begin/endGesture. */
  moveMarker: (markerId: string, timeMs: number) => void;
  renameMarker: (markerId: string, label: string) => void;
  removeMarker: (markerId: string) => void;
  /** Replace the whole editor content (restore from IndexedDB at boot). */
  hydrate: (project: Project, assets: MediaAsset[]) => void;
  /** Start over: empty project, empty library, empty history. */
  resetProject: () => void;
  setPxPerSec: (v: number) => void;
  setTimelinePadLeft: (px: number) => void;
  setInspectorOpen: (open: boolean) => void;
  setLibraryOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setPreferencesOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  /** Open the right-click menu for `target` at viewport coords (x, y). */
  openContextMenu: (x: number, y: number, target: ContextTarget) => void;
  closeContextMenu: () => void;
  /** Open (id) or close (null) a marker's inline label editor. */
  setRenamingMarker: (markerId: string | null) => void;
  setTimeFormat: (format: TimeFormat) => void;
  /** Pick the preview resolution rung; persisted. */
  setPreviewResolution: (mode: PreviewResolutionMode) => void;
  setExportOpen: (open: boolean) => void;
  setImporting: (v: boolean) => void;
  setError: (msg: string | null) => void;
}
