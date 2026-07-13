import { useEffect } from 'react';
import { useStore, getSelectedClip, projectDurationMs, clipEndMs } from '../store/store';
import { clamp } from '../lib/time';

/** Zoom keeping the playhead at the same screen position (falls back to plain zoom). */
function zoomAtPlayhead(factor: number) {
  const s = useStore.getState();
  const scroller = document.querySelector<HTMLElement>('.timeline-scroller');
  const oldPxMs = s.pxPerSec / 1000;
  s.setPxPerSec(s.pxPerSec * factor);
  const newPxMs = useStore.getState().pxPerSec / 1000;
  if (!scroller) return;
  const pad = s.timelinePadLeft;
  const anchorView = clamp(pad + s.currentTimeMs * oldPxMs - scroller.scrollLeft, 0, scroller.clientWidth);
  scroller.scrollLeft = pad + s.currentTimeMs * newPxMs - anchorView;
}

/** Jump to the previous/next edit point (clip edges, origin, project end) — Vegas-style. */
function jumpToEdge(dir: -1 | 1) {
  const s = useStore.getState();
  const points = new Set<number>([0, projectDurationMs(s.project)]);
  for (const track of s.project.tracks) {
    for (const clip of track.clips) {
      points.add(clip.timelineStartMs);
      points.add(clipEndMs(clip));
    }
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

      if (e.code === 'Space') {
        e.preventDefault();
        s.setPlaying(!s.playing);
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
            if (s.selectedClipId) {
              e.preventDefault();
              s.copyClip(s.selectedClipId);
            }
            return;
          case 'x':
            if (s.selectedClipId) {
              e.preventDefault();
              s.cutClip(s.selectedClipId);
            }
            return;
          case 'v':
            e.preventDefault();
            s.pasteAtPlayhead();
            return;
          case 'd':
            if (s.selectedClipId) {
              e.preventDefault();
              s.duplicateClip(s.selectedClipId);
            }
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
          if (s.selectedClipId) s.deleteClip(s.selectedClipId);
          return;
      }

      switch (e.key.toLowerCase()) {
        case 's':
          s.splitAtPlayhead();
          return;
        case 'j':
          stepBy(-1000);
          return;
        case 'k':
          if (s.playing) s.setPlaying(false);
          return;
        case 'l':
          if (!s.playing) s.setPlaying(true);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
