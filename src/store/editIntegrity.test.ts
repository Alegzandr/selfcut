import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Clip, MediaAsset, Project } from '../types';
import { clipDurationMs, clipEndMs, isCompClip, tracksOf } from '../model';
import { createEmptyProject } from './projectOps';

/**
 * Edits that must keep the project consistent across gestures, compositions,
 * links and ramps: comp clips retimed after a drag, a gesture that cannot be
 * stranded by undo, paste refusing a cycle, ripple and paste-insert scoped to
 * the open timeline, linked partners kept in sync at t=0, ramped trims landing
 * under the pointer.
 *
 * Store bootstrapped like the other store suites: node environment, so
 * `document` is stubbed before the module graph is pulled in.
 */

let useStore: typeof import('./store').useStore;
let rippleForTrim: typeof import('../timeline/clipDrag').rippleForTrim;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
  ({ rippleForTrim } = await import('../timeline/clipDrag'));
});

function videoAsset(id: string, durationMs = 5000, withAudio = false): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio: withAudio,
    audioTracks: withAudio ? [{ index: 0, channels: 2 }] : [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const lanes = () => tracksOf(s().project, s().activeCompId);
const clips = () => lanes().flatMap((t) => t.clips);
const rootClips = () => s().project.tracks.flatMap((t) => t.clips);
const clipById = (id: string) =>
  [...rootClips(), ...(s().project.comps ?? []).flatMap((c) => c.tracks.flatMap((t) => t.clips))].find(
    (c) => c.id === id,
  )!;

/** Rewrite one clip's start in place, outside any edit command. */
function placeAt(clipId: string, timelineStartMs: number) {
  const project: Project = {
    ...s().project,
    tracks: s().project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, timelineStartMs } : c)),
    })),
  };
  useStore.setState({ project });
}

/** The (video, audio) clips of the single linked pair on the timeline. */
function pair(): { video: Clip; audio: Clip } {
  const all = s().project.tracks.flatMap((t) => t.clips.map((c) => ({ c, kind: t.kind })));
  return {
    video: all.find((x) => x.kind === 'video')!.c,
    audio: all.find((x) => x.kind === 'audio')!.c,
  };
}

beforeEach(() => {
  s().resetProject();
  // A gesture a failing case left open would swallow the next case's history.
  useStore.setState({ gestureSnapshot: null });
  s().openComp(null);
  s().setRippleAcrossTracks(false);
  s().addAsset(videoAsset('v'));
});

describe('gestures', () => {
  it('retimes the clip playing a composition edited during a gesture', () => {
    s().addClipFromAsset('v');
    const compId = s().precompose([clips()[0]!.id])!;
    s().openComp(compId);
    const inner = clips()[0]!;
    s().beginGesture();
    s().trimClip(inner.id, 'right', 3000);
    s().endGesture();
    s().openComp(null);
    const compClip = rootClips().find(isCompClip)!;
    expect(clipDurationMs(compClip)).toBeCloseTo(3000, 6);
  });

  it('keeps the outermost snapshot when a gesture is begun twice', () => {
    s().addClipFromAsset('v');
    const id = clips()[0]!.id;
    s().beginGesture();
    s().moveClip(id, 1000);
    s().beginGesture();
    s().moveClip(id, 2000);
    s().endGesture();
    s().undo();
    expect(clipById(id).timelineStartMs).toBe(0);
  });

  it('commits an open gesture before undoing, so later edits still record', () => {
    s().addClipFromAsset('v');
    const id = clips()[0]!.id;
    s().beginGesture();
    s().moveClip(id, 1000);
    s().undo();
    expect(s().gestureSnapshot).toBeNull();
    expect(clipById(id).timelineStartMs).toBe(0);
    const before = s().past.length;
    s().addClipFromAsset('v');
    expect(s().past.length).toBe(before + 1);
  });
});

describe('paste', () => {
  it('refuses to paste a composition clip inside its own composition', () => {
    s().addClipFromAsset('v');
    const compId = s().precompose([clips()[0]!.id])!;
    s().copyClips([clips()[0]!.id]);
    s().openComp(compId);
    s().pasteAtPlayhead();
    expect(clips().some(isCompClip)).toBe(false);
    expect(s().notice).toBeTruthy();
  });

  it('opens the room for a paste-insert inside the composition, not the root', () => {
    s().addClipFromAsset('v');
    s().addClipFromAsset('v');
    const [a, b] = clips();
    const compId = s().precompose([b!.id])!;
    s().openComp(compId);
    s().copyClips([clips()[0]!.id]);
    s().seek(2500);
    s().pasteInsertAtPlayhead();
    // Inside: razored at the playhead, plus the pasted copy.
    expect(clips()).toHaveLength(3);
    s().openComp(null);
    // The root clip under the same instant is untouched.
    const rootA = rootClips().filter((c) => !isCompClip(c));
    expect(rootA).toHaveLength(1);
    expect(rootA[0]!.id).toBe(a!.id);
    expect(clipDurationMs(rootA[0]!)).toBe(5000);
  });

  it('drops the clipboard when another project is loaded', () => {
    s().addClipFromAsset('v');
    s().copyClips([clips()[0]!.id]);
    expect(s().clipboard).not.toBeNull();
    s().hydrate(createEmptyProject(), []);
    expect(s().clipboard).toBeNull();
  });
});

describe('ripple on every track inside a composition', () => {
  it('closes a gap measured on the composition, not the root', () => {
    s().addClipFromAsset('v');
    s().addClipFromAsset('v');
    const compId = s().precompose(clips().map((c) => c.id))!;
    s().openComp(compId);
    const second = clips().find((c) => c.timelineStartMs === 5000)!;
    s().moveClips([{ clipId: second.id, timelineStartMs: 10000 }]);
    s().setRippleAcrossTracks(true);
    s().closeGap(lanes()[0]!.id, 7000);
    expect(clipById(second.id).timelineStartMs).toBe(5000);
  });

  it('closes the gap at the playhead on the composition too', () => {
    s().addClipFromAsset('v');
    s().addClipFromAsset('v');
    const compId = s().precompose(clips().map((c) => c.id))!;
    s().openComp(compId);
    const second = clips().find((c) => c.timelineStartMs === 5000)!;
    s().moveClips([{ clipId: second.id, timelineStartMs: 10000 }]);
    s().setRippleAcrossTracks(true);
    s().seek(7000);
    s().closeGapsAtPlayhead();
    expect(clipById(second.id).timelineStartMs).toBe(5000);
  });
});

describe('linked partners', () => {
  beforeEach(() => {
    s().addAsset(videoAsset('va', 5000, true));
    s().addClipFromAsset('va');
  });

  it('ripple trim does not capture the trimmed clip’s own partner', () => {
    const { video, audio } = pair();
    s().moveClip(video.id, 10000);
    const live = clipById(video.id);
    const captured = rippleForTrim(s().project, live, 'left', true);
    expect(captured.map((c) => c.id)).not.toContain(audio.id);
    // The ripple-left trim the drag performs: trim 1 s, pull the clip back.
    s().trimClip(video.id, 'left', 11000);
    s().moveClips([
      { clipId: video.id, timelineStartMs: 10000 },
      ...captured.map((r) => ({ clipId: r.id, timelineStartMs: r.startMs - 1000 })),
    ]);
    expect(clipById(audio.id).timelineStartMs).toBe(clipById(video.id).timelineStartMs);
  });

  it('stops the whole group at t=0 when a partner starts earlier (moveClip)', () => {
    const { video, audio } = pair();
    placeAt(video.id, 2000);
    placeAt(audio.id, 500);
    s().moveClip(video.id, 0);
    expect(clipById(audio.id).timelineStartMs).toBe(0);
    expect(clipById(video.id).timelineStartMs).toBe(1500);
  });

  it('stops the whole group at t=0 when a partner starts earlier (moveClips)', () => {
    const { video, audio } = pair();
    placeAt(video.id, 2000);
    placeAt(audio.id, 500);
    s().moveClips([{ clipId: video.id, timelineStartMs: 0 }]);
    expect(clipById(audio.id).timelineStartMs).toBe(0);
    expect(clipById(video.id).timelineStartMs).toBe(1500);
  });
});

describe('trimming a ramped clip', () => {
  function ramped(): Clip {
    s().addAsset(videoAsset('long', 10000));
    s().addClipFromAsset('long');
    const clip = clips().find((c) => c.assetId === 'long')!;
    s().updateClipCommitted(clip.id, {
      velocity: [
        { t: 0, value: 0.5, ease: 'linear' },
        { t: 10000, value: 2, ease: 'linear' },
      ],
    });
    return clipById(clip.id);
  }

  it('lands the left edge under the pointer and holds the right edge', () => {
    const clip = ramped();
    const end = clipEndMs(clip);
    s().trimClip(clip.id, 'left', clip.timelineStartMs + 1000);
    const after = clipById(clip.id);
    expect(after.timelineStartMs).toBeCloseTo(clip.timelineStartMs + 1000, 0);
    expect(Math.abs(clipEndMs(after) - end)).toBeLessThan(5);
  });

  it('lands the right edge under the pointer', () => {
    const clip = ramped();
    const target = clipEndMs(clip) - 1000;
    s().trimClip(clip.id, 'right', target);
    const after = clipById(clip.id);
    expect(Math.abs(clipEndMs(after) - target)).toBeLessThan(5);
    expect(after.timelineStartMs).toBe(clip.timelineStartMs);
  });
});
