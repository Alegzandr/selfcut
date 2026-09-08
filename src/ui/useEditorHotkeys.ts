import { useEffect } from 'react';
import { useStore, getTimelineFps, projectDurationMs, clipEndMs, sortedMarkers } from '../store/store';
import { zoomAtPlayhead, zoomToFit } from '../timeline/zoom';
import { EASE_IDS } from '../model';
import { focusIsKeyboardDriven } from '../lib/focusModality';
import { openProject, saveProject } from './projectActions';
import { PLAYBACK_SKIP_BACK_MS, PLAYBACK_SKIP_FORWARD_MS } from '../app/config';
import { shuttleStep } from '../lib/shuttle';

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

/**
 * Trim the selected clips' edge to the playhead - every selected clip the
 * playhead is inside, as one undo step. A stacked selection (a shot and the
 * graphics over it) trims together, which is the point of selecting it.
 */
function trimSelectedToPlayhead(edge: 'left' | 'right') {
  const s = useStore.getState();
  const selected = new Set(s.selectedClipIds);
  const targets = s.project.tracks
    .flatMap((tr) => tr.clips)
    .filter(
      (clip) =>
        selected.has(clip.id) &&
        s.currentTimeMs > clip.timelineStartMs + 1 &&
        s.currentTimeMs < clipEndMs(clip) - 1,
    );
  if (targets.length === 0) return;
  s.beginGesture();
  for (const clip of targets) s.trimClip(clip.id, edge, s.currentTimeMs);
  s.endGesture();
}

function stepBy(ms: number) {
  const s = useStore.getState();
  s.seek(s.currentTimeMs + ms);
}

/**
 * One press of J (-1) or L (1): take the ladder's next rung and run.
 *
 * The rate is set before the transport starts, so the engine's first tick after
 * the press already anchors itself on the direction that was asked for - a play
 * that started forwards and turned round a frame later is a jump backwards on
 * screen and a click in the sound.
 */
function shuttle(dir: -1 | 1) {
  const s = useStore.getState();
  const next = shuttleStep(s.playbackRate, s.playing, dir);
  s.setPlaybackRate(next.rate);
  if (next.playing !== s.playing) s.setPlaying(next.playing);
}

/** One frame of the timeline, in ms - at the footage's rate, not the project ceiling. */
function frameMs(): number {
  return 1000 / getTimelineFps(useStore.getState());
}

/** Cue the playhead to the next (1) or previous (-1) marker, Premiere's Shift+M pair. */
function jumpToMarker(dir: -1 | 1) {
  const s = useStore.getState();
  const markers = sortedMarkers(s.project);
  const target =
    dir === 1
      ? markers.find((m) => m.timeMs > s.currentTimeMs + 1)
      : [...markers].reverse().find((m) => m.timeMs < s.currentTimeMs - 1);
  if (target) s.seek(target.timeMs);
}

/**
 * Toggle the expand/collapse state of every track that owns a currently
 * selected clip (all tracks when nothing is selected). If any target row is
 * already expanded, they all collapse - matches the header chevron and reads
 * as one action on the group.
 */
function toggleTrackExpansion() {
  const s = useStore.getState();
  const targets: string[] = [];
  if (s.selectedClipIds.length === 0) {
    for (const track of s.project.tracks) targets.push(track.id);
  } else {
    const selected = new Set(s.selectedClipIds);
    for (const track of s.project.tracks) {
      if (track.clips.some((c) => selected.has(c.id))) targets.push(track.id);
    }
  }
  if (!targets.length) return;
  const anyExpanded = targets.some((id) => s.expandedTrackIds.includes(id));
  const cur = new Set(s.expandedTrackIds);
  for (const id of targets) {
    if (anyExpanded) cur.delete(id);
    else cur.add(id);
  }
  // Direct set: one commit, no history entry (expansion is view state).
  useStore.setState({ expandedTrackIds: [...cur] });
}

/** Move the selected clip(s) by N frames (one undo step per press). */
function nudgeSelected(frames: number) {
  const s = useStore.getState();
  if (s.selectedClipIds.length === 0) return;
  const step = frameMs() * frames;
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
 * Asked of the focus modality rather than of `:focus-visible`, which the
 * browser has already flipped to true by the time a keydown handler runs - see
 * `focusModality`.
 */
function keyboardFocusedButton(el: HTMLElement): boolean {
  if (!el.closest?.('button')) return false;
  return focusIsKeyboardDriven();
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

      // F9 is After Effects' Easy Ease, muscle memory for anyone arriving from
      // it. Shift and Ctrl+Shift are its one-sided variants, same as there.
      if (e.key === 'F9') {
        e.preventDefault();
        if (s.selectedKeyframes.length) {
          s.setSelectedKeyframesEase(mod && e.shiftKey ? 'out' : e.shiftKey ? 'in' : 'inOut');
        }
        return;
      }

      // Shift+Z: the whole cut in the window, the fit every NLE puts on this
      // key. Matched before the letter switch below, where a bare Z arms the
      // magnifier and used to swallow the shifted press as well.
      if (!mod && e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        zoomToFit();
        return;
      }

      // Alt + arrows: nudge the selection by a frame, Alt+Shift by ten - the
      // Premiere pair, kept on the arrows so it works on every keyboard layout
      // (the , / . pair below depends on where the layout puts them).
      if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        nudgeSelected(dir * (e.shiftKey ? 10 : 1));
        return;
      }
      // Alt + up/down: lift the selection onto the neighbouring lane.
      if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        s.moveSelectionToTrack(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }

      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) s.redo();
            else s.undo();
            return;
          case 'backspace':
            // Ctrl+Backspace: close the gap(s) under the playhead. Backspace
            // alone deletes the selection, so the modifier is what says
            // "the empty space, not the clip".
            e.preventDefault();
            s.closeGapsAtPlayhead();
            return;
          case 'm':
            // Ctrl+Shift+M: previous marker (Shift+M alone is the next one).
            if (e.shiftKey) {
              e.preventDefault();
              jumpToMarker(-1);
            }
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
            if (e.shiftKey) s.pasteInsertAtPlayhead();
            else s.pasteAtPlayhead();
            return;
          case 'd':
            if (s.selectedClipIds.length) {
              e.preventDefault();
              s.duplicateClips(s.selectedClipIds);
            }
            return;
          case 'a':
            e.preventDefault();
            if (e.shiftKey) s.selectClipsAfterPlayhead();
            else s.selectAllClips();
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

      // Easing of the boxed keyframes, Alt + the picker's own order. Alt rather
      // than a bare digit because 1…9 are the marker cue keys below, and a
      // monteur uses those far more often than they re-ease a curve.
      const easeDigit = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
      if (e.altKey && !mod && easeDigit && s.selectedKeyframes.length) {
        e.preventDefault();
        const ease = EASE_IDS[Number(easeDigit[1]) - 1];
        if (ease) s.setSelectedKeyframesEase(ease);
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
        // Playing, the arrows skip like a player's do (and asymmetrically, see
        // the constants); stopped, they step a frame, which is the edit
        // gesture. Shift stays the one-second nudge in both states, so the fine
        // grain is still reachable without stopping playback.
        case 'ArrowLeft':
          e.preventDefault();
          stepBy(
            e.shiftKey
              ? -1000
              : s.playing
                ? -PLAYBACK_SKIP_BACK_MS
                : -frameMs(),
          );
          return;
        case 'ArrowRight':
          e.preventDefault();
          stepBy(
            e.shiftKey
              ? 1000
              : s.playing
                ? PLAYBACK_SKIP_FORWARD_MS
                : frameMs(),
          );
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
          // A boxed set of keyframes takes the key: deleting the clips under it
          // instead would be a wildly bigger edit than the selection shows.
          if (s.selectedKeyframes.length) s.deleteSelectedKeyframes();
          else s.deleteClips(s.selectedClipIds, e.shiftKey);
          return;
        case ',':
          nudgeSelected(-1);
          return;
        case '.':
          nudgeSelected(1);
          return;
        // Shift + , / . on the layouts where that types < and >: ten frames.
        case '<':
          nudgeSelected(-10);
          return;
        case '>':
          nudgeSelected(10);
          return;
        case 'M':
          // Shift+M: next marker. The lowercase m below drops one.
          if (e.shiftKey) {
            jumpToMarker(1);
            return;
          }
          break;
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
        case 'g':
          // The graph editor, on the letter every NLE gives it. Opening it with
          // nothing boxed would show an empty panel, so it only toggles when
          // there is a curve to show - or when it is already open, to close it.
          if (s.curveEditorOpen) s.setCurveEditorOpen(false);
          else if (s.selectedKeyframes.length) s.setCurveEditorOpen(true);
          return;
        case 'e':
          // Adobe's reflex: E toggles the "expand track" view. Targets the
          // tracks that own the current selection, or every track when nothing
          // is selected. When any of them is already expanded, they collapse
          // together (matches the header chevron's toggle semantics).
          toggleTrackExpansion();
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
        // J and L are one ladder read in two directions (see `shuttleStep`):
        // J plays backwards, L forwards, and each pressed against the current
        // direction of travel slows the transport down before turning it round.
        case 'j':
          shuttle(-1);
          return;
        case 'k':
          // Always stops AND drops the shuttle back to 1x, as in Premiere and
          // Resolve. Unconditional: pausing an already-paused transport is what
          // clears a rate left at 0.25 by a run of J presses.
          s.setPlaying(false);
          return;
        case 'l':
          shuttle(1);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
