import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { gapAt, isTrackAudible, isTrackSoloedOut, isTrackVisible, timelineFps } from '../model';

/**
 * The cut-room commands added for the pro pass: closing gaps, paste-insert,
 * select-forward, lifting a selection across lanes, track solo and the
 * footage-driven timeline frame rate. Store bootstrapped like
 * proInteractions.test.ts: node environment, so document is stubbed.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, durationMs = 5000, fps?: number): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
    ...(fps ? { fps } : {}),
  };
}

const s = () => useStore.getState();
const videoTrack = () => s().project.tracks.find((t) => t.kind === 'video')!;
const starts = () => videoTrack().clips.map((c) => c.timelineStartMs).sort((a, b) => a - b);

beforeEach(() => {
  s().resetProject();
});

/** Three 5s clips end to end on V1, then a 2s hole punched between the first two. */
function threeClipsWithGap() {
  s().addAsset(videoAsset('v'));
  s().addClipFromAsset('v');
  s().addClipFromAsset('v');
  s().addClipFromAsset('v');
  const [a, b, c] = [...videoTrack().clips].sort((x, y) => x.timelineStartMs - y.timelineStartMs);
  s().moveClips([
    { clipId: b!.id, timelineStartMs: 7000 },
    { clipId: c!.id, timelineStartMs: 12000 },
  ]);
  return { a: a!, b: b!, c: c! };
}

describe('gapAt', () => {
  it('finds the hole between two clips and nothing under a clip or past the end', () => {
    threeClipsWithGap();
    const track = videoTrack();
    expect(gapAt(track, 6000)).toEqual({ startMs: 5000, endMs: 7000 });
    expect(gapAt(track, 2000)).toBeNull();
    expect(gapAt(track, 30000)).toBeNull();
  });
});

describe('closeGap', () => {
  it('slides everything after the gap left by its length, as one undo step', () => {
    threeClipsWithGap();
    const before = s().past.length;
    s().closeGap(videoTrack().id, 6000);
    expect(starts()).toEqual([0, 5000, 10000]);
    expect(s().past.length).toBe(before + 1);
    s().undo();
    expect(starts()).toEqual([0, 7000, 12000]);
  });

  it('does nothing under a clip, on a locked track, or after the last clip', () => {
    threeClipsWithGap();
    s().closeGap(videoTrack().id, 1000);
    s().closeGap(videoTrack().id, 40000);
    expect(starts()).toEqual([0, 7000, 12000]);
    s().toggleTrackLocked(videoTrack().id);
    s().closeGap(videoTrack().id, 6000);
    expect(starts()).toEqual([0, 7000, 12000]);
  });

  it('closes the gap under the playhead on every track that has one', () => {
    threeClipsWithGap();
    s().seek(6500);
    s().closeGapsAtPlayhead();
    expect(starts()).toEqual([0, 5000, 10000]);
  });
});

describe('pasteInsertAtPlayhead', () => {
  it('pushes what follows the playhead right by the pasted span', () => {
    threeClipsWithGap();
    const first = videoTrack().clips.find((c) => c.timelineStartMs === 0)!;
    s().copyClips([first.id]);
    s().seek(7000);
    s().pasteInsertAtPlayhead();
    expect(starts()).toEqual([0, 7000, 12000, 17000]);
    // The pasted clip sits at the playhead and is the selection.
    const pasted = videoTrack().clips.find((c) => c.id === s().selectedClipId)!;
    expect(pasted.timelineStartMs).toBe(7000);
  });

  it('razors a clip straddling the playhead and slides its tail with the rest', () => {
    threeClipsWithGap();
    const first = videoTrack().clips.find((c) => c.timelineStartMs === 0)!;
    s().copyClips([first.id]);
    s().seek(2000);
    s().pasteInsertAtPlayhead();
    // The first clip is cut at 2s: its head stays, its tail (and everything
    // after) moves 5s right, and the paste fills the room at 2s.
    expect(starts()).toEqual([0, 2000, 7000, 12000, 17000]);
    const head = videoTrack().clips.find((c) => c.timelineStartMs === 0)!;
    expect(head.sourceOutMs).toBe(2000);
    const tail = videoTrack().clips.find((c) => c.timelineStartMs === 7000)!;
    expect(tail.sourceInMs).toBe(2000);
  });

  it('opens room on every unlocked track, not only the ones receiving clips', () => {
    threeClipsWithGap();
    s().addTrack('audio');
    // A lone audio clip far down the cut has to slide too, or it desyncs.
    const audio = s().project.tracks.find((t) => t.kind === 'audio')!;
    s().addAsset({ ...videoAsset('a'), kind: 'audio', hasAudio: true, audioTracks: [{ index: 0, channels: 2 }] });
    s().addClipFromAssetAt('a', 20000, audio.id);
    const first = videoTrack().clips.find((c) => c.timelineStartMs === 0)!;
    s().copyClips([first.id]);
    s().seek(7000);
    s().pasteInsertAtPlayhead();
    const audioClip = s().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect(audioClip.timelineStartMs).toBe(25000);
  });
});

describe('selectClipsAfterPlayhead', () => {
  it('selects every clip ending after the playhead, skipping locked tracks', () => {
    const { a, b, c } = threeClipsWithGap();
    s().seek(6000);
    s().selectClipsAfterPlayhead();
    expect(new Set(s().selectedClipIds)).toEqual(new Set([b.id, c.id]));
    s().seek(1000);
    s().selectClipsAfterPlayhead();
    expect(new Set(s().selectedClipIds)).toEqual(new Set([a.id, b.id, c.id]));
  });
});

describe('moveSelectionToTrack', () => {
  it('lifts the selection onto the next lane of its kind, keeping its time', () => {
    threeClipsWithGap();
    s().addTrack('video');
    const from = videoTrack();
    const clip = from.clips.find((c) => c.timelineStartMs === 7000)!;
    s().selectClip(clip.id);
    s().moveSelectionToTrack(1);
    const tracks = s().project.tracks.filter((t) => t.kind === 'video');
    expect(tracks[0]!.clips.some((c) => c.id === clip.id)).toBe(false);
    const moved = tracks[1]!.clips.find((c) => c.id === clip.id)!;
    expect(moved.timelineStartMs).toBe(7000);
    expect(moved.trackId).toBe(tracks[1]!.id);
  });

  it('refuses when there is no lane to go to', () => {
    threeClipsWithGap();
    const clip = videoTrack().clips[0]!;
    s().selectClip(clip.id);
    s().moveSelectionToTrack(-1);
    expect(videoTrack().clips.some((c) => c.id === clip.id)).toBe(true);
  });
});

describe('splitAtPlayhead with a multi-selection', () => {
  it('razors every selected clip under the playhead, not just the primary', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    s().addTrack('video');
    const v2 = s().project.tracks.filter((t) => t.kind === 'video')[1]!;
    s().addClipFromAssetAt('v', 0, v2.id);
    s().selectAllClips();
    s().seek(2500);
    s().splitAtPlayhead();
    for (const track of s().project.tracks.filter((t) => t.kind === 'video')) {
      expect(track.clips).toHaveLength(2);
    }
  });
});

describe('track solo', () => {
  it('silences the other audio lanes and hides the other video lanes of the soloed kind only', () => {
    s().addTrack('video');
    s().addTrack('video');
    s().addTrack('audio');
    s().addTrack('audio');
    const [v1, v2, a1, a2] = s().project.tracks;
    s().toggleTrackSolo(a1!.id);
    const p = s().project;
    const track = (id: string) => p.tracks.find((t) => t.id === id)!;
    expect(isTrackAudible(track(a1!.id), p)).toBe(true);
    expect(isTrackAudible(track(a2!.id), p)).toBe(false);
    expect(isTrackSoloedOut(track(a2!.id), p)).toBe(true);
    // An audio solo leaves the picture alone, and a video lane's own sound
    // follows the audio rule.
    expect(isTrackVisible(track(v1!.id), p)).toBe(true);
    expect(isTrackVisible(track(v2!.id), p)).toBe(true);
    expect(isTrackAudible(track(v1!.id), p)).toBe(false);

    s().toggleTrackSolo(v2!.id);
    const q = s().project;
    expect(isTrackVisible(q.tracks.find((t) => t.id === v1!.id)!, q)).toBe(false);
    expect(isTrackVisible(q.tracks.find((t) => t.id === v2!.id)!, q)).toBe(true);
  });

  it('mute still wins over solo', () => {
    s().addTrack('audio');
    const a1 = s().project.tracks[0]!;
    s().toggleTrackSolo(a1.id);
    s().toggleTrackMuted(a1.id);
    const p = s().project;
    expect(isTrackAudible(p.tracks[0]!, p)).toBe(false);
  });
});

describe('renameTrack', () => {
  it('stores a trimmed name and clears it on an empty one', () => {
    s().addTrack('audio');
    const id = s().project.tracks[0]!.id;
    s().renameTrack(id, '  Music ');
    expect(s().project.tracks[0]!.name).toBe('Music');
    s().renameTrack(id, '   ');
    expect(s().project.tracks[0]!.name).toBeUndefined();
  });
});

describe('timelineFps', () => {
  it('follows the fastest footage on the timeline, snapped to a real rate', () => {
    expect(timelineFps(s().project, s().assets)).toBe(60);
    s().addAsset(videoAsset('a', 5000, 29.97));
    s().addClipFromAsset('a');
    expect(timelineFps(s().project, s().assets)).toBe(30);
    s().addAsset(videoAsset('b', 5000, 23.976));
    s().addClipFromAsset('b');
    expect(timelineFps(s().project, s().assets)).toBe(30);
    s().addAsset(videoAsset('c', 5000, 50));
    s().addClipFromAsset('c');
    expect(timelineFps(s().project, s().assets)).toBe(50);
  });
});

describe('markers', () => {
  it('colours a marker and clears them all in one undo step', () => {
    s().seek(1000);
    s().addMarkerAtPlayhead();
    s().seek(2000);
    s().addMarkerAtPlayhead();
    const id = s().project.markers[0]!.id;
    s().setMarkerColor(id, 'red');
    expect(s().project.markers.find((m) => m.id === id)!.color).toBe('red');
    const before = s().past.length;
    s().removeAllMarkers();
    expect(s().project.markers).toHaveLength(0);
    expect(s().past.length).toBe(before + 1);
  });
});
