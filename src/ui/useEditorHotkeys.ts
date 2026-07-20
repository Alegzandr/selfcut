import { useEffect } from 'react';
import { useStore, getSelectedClip, projectDurationMs, clipEndMs, sortedMarkers } from '../store/store';
import { zoomAtPlayhead } from '../timeline/zoom';
import { openProject, saveProject } from './projectActions';

/**
 * Jump to the previous/next edit point (clip edges, markers, region corners,
 * origin, project end) - Vegas-style.
 */
function jumpToEdge(dir: -1 | 1) {
  const s = useStore.getState();
  const points = new Set<number>([0, projectDurationMs(s.project)]);
  for (const track of s.project.tracks) {
    for (const clip of track.clips) {
      points.add(clip.timelineStartMs);
      points.add(clipEndMs(clip));
    }
  }
  for (const marker of sortedMarkers(s.project)) points.add(marker.timeMs);
  if (s.loopRegion) {
    points.add(s.loopRegion.startMs);
    points.add(s.loopRegion.endMs);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const cur = s.currentTimeMs;
  const target =
    dir === 1
      ? sorted.find((p) => p > cur + 1)
      : [...sorted].reverse().find((p) => p < cur - 1);
  if (target !== undefined) s.seek(target);
}

/** Trim the selected clip's edge to the playhead (only when the playhead is inside it). */
function trimSelectedToPlayhead(edge: 'left' | 'right') {
  const s = useStore.getState();
  const clip = getSelectedClip(s);
  if (!clip) return;
  if (s.currentTimeMs <= clip.timelineStartMs + 1 || s.currentTimeMs >= clipEndMs(clip) - 1) return;
  s.beginGesture();
  s.trimClip(clip.id, edge, s.currentTimeMs);
  s.endGesture();
}

function stepBy(ms: number) {
  const s = useStore.getState();
  s.seek(s.currentTimeMs + ms);
}

/** Move the selected clip(s) by N frames (one undo step per press). */
function nudgeSelected(frames: number) {
  const s = useStore.getState();
  if (s.selectedClipIds.length === 0) return;
  const step = (1000 / s.project.fps) * frames;
  const entries: { clipId: string; timelineStartMs: number }[] = [];
  for (const track of s.project.tracks) {
    for (const clip of track.clips) {
      if (s.selectedClipIds.includes(clip.id)) {
        entries.push({ clipId: clip.id, timelineStartMs: clip.timelineStartMs + step });
      }
    }
  }
  s.beginGesture();
  s.moveClips(entries);
  s.endGesture();
}

/**
 * True when `el` sits in a button the user reached with the keyboard. Focus
 * left over from a *click* does not count: the pointer user has moved on and
 * expects Space to still drive playback.
 *
 * `:focus-visible` is the browser's own answer to "should this focus be shown",
 * which is exactly the distinction we need - guarded because an engine that
 * does not know the selector throws on `matches` rather than returning false.
 */
function keyboardFocusedButton(el: HTMLElement): boolean {
  const btn = el.closest?.('button');
  if (!btn) return false;
  try {
    return btn.matches(':focus-visible');
  } catch {
    return true; // Unknown selector: keep the old, accessibility-safe behavior.
  }
}

export function useEditorHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      // A modal dialog open: the timeline must go inert - a stray Space or
      // Delete must not edit behind it. Each dialog handles Escape itself.
      if (s.exportOpen || s.preferencesOpen || s.aboutOpen || s.confirmDialog) return;

      // The shortcuts panel is the one dialog whose dismissal is owned here
      // rather than by the dialog itself, so Escape and the '?' toggle still
      // have to reach the switch below - but nothing else does.
      if (s.shortcutsOpen && e.key !== 'Escape' && e.key !== '?') return;

      if (e.code === 'Space') {
        // A button reached by keyboard owns Space (activation): stealing it
        // would make the whole app un-drivable with the keyboard. A button
        // merely *clicked* keeps the DOM focus but not :focus-visible, and the
        // user is back on the mouse - Space belongs to play/pause there, which
        // is what they expect after hitting Split or a menu item.
        if (keyboardFocusedButton(target)) return;
        e.preventDefault();
        s.setPlaying(!s.playing);
        return;
      }

      // AZERTY (Windows): [ and ] are typed with AltGr, which reports
      // ctrlKey=true - route them to trim before the Ctrl-shortcut branch
      // swallows them.
      if (e.ctrlKey && e.altKey && (e.key === '[' || e.key === ']')) {
        trimSelectedToPlayhead(e.key === '[' ? 'left' : 'right');
        return;
      }

      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) s.redo();
            else s.undo();
            return;
          case 'y':
            e.preventDefault();
            s.redo();
            return;
          case 'c':
            if (s.selectedClipIds.length) {
              e.preventDefault();
              s.copyClips(s.selectedClipIds);
            }
            return;
          case 'x':
            if (s.selectedClipIds.length) {
              e.preventDefault();
              s.cutClips(s.selectedClipIds);
            }
            return;
          case 'v':
            e.preventDefault();
            s.pasteAtPlayhead();
            return;
          case 'd':
            if (s.selectedClipIds.length) {
              e.preventDefault();
              s.duplicateClips(s.selectedClipIds);
            }
            return;
          case 'a':
            e.preventDefault();
            s.selectAllClips();
            return;
          case 'e':
            e.preventDefault();
            s.setExportOpen(true);
            return;
          case 's':
            // Always swallowed, so the browser's "Save page as…" never fires.
            e.preventDefault();
            // Called straight from the handler: the save picker needs the
            // transient user activation this keypress carries.
            saveProject(e.shiftKey);
            return;
          case 'o':
            e.preventDefault();
            openProject();
            return;
          case 'arrowleft':
            e.preventDefault();
            jumpToEdge(-1);
            return;
          case 'arrowright':
            e.preventDefault();
            jumpToEdge(1);
            return;
        }
        return;
      }

      // 1…9: jump to the n-th marker (Vegas-style cue keys). Matched on
      // e.code so the digit row works on AZERTY too (where unshifted e.key
      // is "&", "é", …), plus the numpad.
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (digit) {
        const marker = sortedMarkers(s.project)[Number(digit[1]) - 1];
        if (marker) s.seek(marker.timeMs);
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          stepBy(e.shiftKey ? -1000 : -1000 / s.project.fps);
          return;
        case 'ArrowRight':
          e.preventDefault();
          stepBy(e.shiftKey ? 1000 : 1000 / s.project.fps);
          return;
        case 'ArrowUp':
          e.preventDefault();
          zoomAtPlayhead(1.25);
          return;
        case 'ArrowDown':
          e.preventDefault();
          zoomAtPlayhead(1 / 1.25);
          return;
        case 'Home':
          e.preventDefault();
          s.seek(0);
          return;
        case 'End':
          e.preventDefault();
          s.seek(projectDurationMs(s.project));
          return;
        case '+':
        case '=':
          zoomAtPlayhead(1.25);
          return;
        case '-':
        case '_':
          zoomAtPlayhead(1 / 1.25);
          return;
        case '[':
          trimSelectedToPlayhead('left');
          return;
        case ']':
          trimSelectedToPlayhead('right');
          return;
        case '?':
          s.setShortcutsOpen(!s.shortcutsOpen);
          return;
        case 'Escape':
          if (s.shortcutsOpen) s.setShortcutsOpen(false);
          else if (s.inspectorOpen) s.setInspectorOpen(false);
          else s.selectClip(null);
          return;
        case 'Delete':
        case 'Backspace':
          s.deleteClips(s.selectedClipIds, e.shiftKey);
          return;
        case ',':
          nudgeSelected(-1);
          return;
        case '.':
          nudgeSelected(1);
          return;
      }

      // Action letters run once per physical press: a held S must not machine-gun
      // splits, a held L must not shoot the shuttle rate to 8x.
      if (e.repeat) return;

      switch (e.key.toLowerCase()) {
        // Razor. Three keys for one action on purpose: S is the Vegas binding
        // this editor grew up with, C is Premiere's and B is Resolve's. Someone
        // arriving from either reaches for a blade key and finds one.
        case 's':
        case 'c':
        case 'b':
          s.splitAtPlayhead();
          return;
        case 't':
          s.addTextClip();
          return;
        case 'i':
          s.setRegionEdgeAtPlayhead('in');
          return;
        case 'o':
          s.setRegionEdgeAtPlayhead('out');
          return;
        case 'q':
          s.toggleLoopEnabled();
          return;
        case 'm':
          s.addMarkerAtPlayhead();
          return;
        case 'p':
          s.punchZoomSelected();
          return;
        case 'n':
          s.toggleSnap();
          return;
        // Preview tools, Photoshop-style. Global rather than scoped to a hovered
        // panel: the preview is always on screen, and every other action letter
        // here works the same way.
        case 'v':
          s.setPreviewTool('select');
          return;
        case 'h':
          s.setPreviewTool('hand');
          return;
        case 'r':
          s.setPreviewTool('shape');
          return;
        case 'z':
          s.setPreviewTool('zoom');
          return;
        case 'j':
          // Playing: halve the shuttle rate (slow review). Paused: step back 1s.
          if (s.playing) s.setPlaybackRate(s.playbackRate / 2);
          else stepBy(-1000);
          return;
        case 'k':
          // Always stops AND drops the shuttle back to 1x, as in Premiere and
          // Resolve. Unconditional: pausing an already-paused transport is what
          // clears a rate left at 0.25 by a run of J presses.
          s.setPlaying(false);
          return;
        case 'l':
          // First press plays at 1×, repeats double the shuttle rate (up to 8×).
          if (!s.playing) s.setPlaying(true);
          else s.setPlaybackRate(s.playbackRate < 1 ? 1 : s.playbackRate * 2);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
