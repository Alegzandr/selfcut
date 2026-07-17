import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';

/**
 * Pro timeline interactions: slip edit (Alt+drag), Ctrl+drag copy
 * (cloneClipsForDrag) and range / marquee selection. Store bootstrapped like
 * linking.test.ts: node environment, so document/structuredClone are stubbed.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown; structuredClone: typeof structuredClone };
  g.document ??= { documentElement: {} };
  g.structuredClone = (<T>(v: T): T => JSON.parse(JSON.stringify(v)) as T) as typeof structuredClone;
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, durationMs = 5000, audioTrackCount = 1): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio: audioTrackCount > 0,
    audioTracks: Array.from({ length: audioTrackCount }, (_, i) => ({ index: i, channels: 2 })),
    thumbnails: [],
  };
}

const s = () => useStore.getState();

/** The single A/V pair on the timeline. */
function pair() {
  const clips = s().project.tracks.flatMap((t) => t.clips.map((c) => ({ c, kind: t.kind })));
  return {
    video: clips.find((x) => x.kind === 'video')!.c,
    audio: clips.find((x) => x.kind === 'audio')!.c,
  };
}

beforeEach(() => {
  s().resetProject();
});

describe('slipClip', () => {
  beforeEach(() => {
    s().addAsset(videoAsset('v', 5000));
    s().addClipFromAsset('v');
    // A 2s window in the middle of the 5s source: room to slip both ways.
    const { video } = pair();
    s().updateClip(video.id, { sourceInMs: 1000, sourceOutMs: 3000 });
    s().updateClip(pair().audio.id, { sourceInMs: 1000, sourceOutMs: 3000 });
  });

  it('slides the source window, keeping position and duration', () => {
    const { video } = pair();
    const start = video.timelineStartMs;
    s().slipClip(video.id, 1500);
    const after = pair().video;
    expect(after.sourceInMs).toBe(1500);
    expect(after.sourceOutMs).toBe(3500);
    expect(after.timelineStartMs).toBe(start);
  });

  it('clamps at the source bounds', () => {
    const { video } = pair();
    s().slipClip(video.id, -400);
    expect(pair().video.sourceInMs).toBe(0);
    expect(pair().video.sourceOutMs).toBe(2000);
    s().slipClip(video.id, 9999);
    expect(pair().video.sourceInMs).toBe(3000);
    expect(pair().video.sourceOutMs).toBe(5000);
  });

  it('slips the linked audio partner in lockstep', () => {
    s().slipClip(pair().video.id, 2000);
    expect(pair().audio.sourceInMs).toBe(2000);
    expect(pair().audio.sourceOutMs).toBe(4000);
  });
});

describe('cloneClipsForDrag', () => {
  it('clones the clip and its linked partner under a fresh shared linkId', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    const orig = pair();

    const idMap = s().cloneClipsForDrag([orig.video.id]);
    const videoClips = s().project.tracks.filter((t) => t.kind === 'video')[0]!.clips;
    const audioClips = s().project.tracks.filter((t) => t.kind === 'audio')[0]!.clips;
    expect(videoClips).toHaveLength(2);
    expect(audioClips).toHaveLength(2);

    const vClone = videoClips.find((c) => c.id === idMap[orig.video.id])!;
    const aClone = audioClips.find((c) => c.id === idMap[orig.audio.id])!;
    // Clones sit exactly on the originals and pair with each other, not the originals.
    expect(vClone.timelineStartMs).toBe(orig.video.timelineStartMs);
    expect(vClone.linkId).toBeTruthy();
    expect(vClone.linkId).toBe(aClone.linkId);
    expect(vClone.linkId).not.toBe(orig.video.linkId);
    // The clones become the selection (the drag moves them next).
    expect(s().selectedClipIds).toEqual([vClone.id]);
  });

  it('moving a clone leaves the original (and its partner) in place', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    const orig = pair();
    const idMap = s().cloneClipsForDrag([orig.video.id]);

    s().moveClip(idMap[orig.video.id]!, 8000);
    const videoClips = s().project.tracks.filter((t) => t.kind === 'video')[0]!.clips;
    expect(videoClips.find((c) => c.id === orig.video.id)!.timelineStartMs).toBe(0);
    expect(videoClips.find((c) => c.id === idMap[orig.video.id])!.timelineStartMs).toBe(8000);
    // The clone's audio partner followed it; the original audio stayed.
    const audioClips = s().project.tracks.filter((t) => t.kind === 'audio')[0]!.clips;
    expect(audioClips.find((c) => c.id === idMap[orig.audio.id])!.timelineStartMs).toBe(8000);
    expect(audioClips.find((c) => c.id === orig.audio.id)!.timelineStartMs).toBe(0);
  });
});

describe('selectClipRange', () => {
  it('selects every clip inside the anchor→target rectangle', () => {
    // Three silent videos in sequence on one track.
    for (const id of ['a', 'b', 'c']) {
      s().addAsset(videoAsset(id, 2000, 0));
      s().addClipFromAsset(id);
    }
    const clips = s().project.tracks[0]!.clips;
    expect(clips).toHaveLength(3);

    s().selectClip(clips[0]!.id);
    s().selectClipRange(clips[0]!.id, clips[2]!.id);
    expect(new Set(s().selectedClipIds)).toEqual(new Set(clips.map((c) => c.id)));
    // The target becomes the primary selection.
    expect(s().selectedClipId).toBe(clips[2]!.id);
  });

  it('ignores clips outside the time span', () => {
    for (const id of ['a', 'b', 'c']) {
      s().addAsset(videoAsset(id, 2000, 0));
      s().addClipFromAsset(id);
    }
    const clips = s().project.tracks[0]!.clips;
    s().selectClipRange(clips[0]!.id, clips[1]!.id);
    expect(s().selectedClipIds).not.toContain(clips[2]!.id);
    expect(s().selectedClipIds).toHaveLength(2);
  });
});

describe('cancelGesture', () => {
  it('restores the pre-gesture project and leaves no undo entry', () => {
    s().addAsset(videoAsset('v', 2000, 0));
    s().addClipFromAsset('v');
    const clip = s().project.tracks[0]!.clips[0]!;
    const pastLen = s().past.length;

    s().beginGesture();
    s().moveClip(clip.id, 5000);
    expect(s().project.tracks[0]!.clips[0]!.timelineStartMs).toBe(5000);
    s().cancelGesture();

    expect(s().project.tracks[0]!.clips[0]!.timelineStartMs).toBe(0);
    expect(s().gestureSnapshot).toBeNull();
    expect(s().past.length).toBe(pastLen);
  });

  it('cancels a Ctrl+drag copy wholesale (the clone vanishes)', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    const before = s().project.tracks.flatMap((t) => t.clips).length;

    s().beginGesture();
    const idMap = s().cloneClipsForDrag([s().project.tracks[0]!.clips[0]!.id]);
    s().moveClip(Object.values(idMap)[0]!, 9000);
    s().cancelGesture();

    expect(s().project.tracks.flatMap((t) => t.clips).length).toBe(before);
  });
});

describe('setSelectedClips', () => {
  it('replaces the selection and clears it with an empty list', () => {
    s().addAsset(videoAsset('v', 2000, 0));
    s().addClipFromAsset('v');
    const clip = s().project.tracks[0]!.clips[0]!;
    s().setSelectedClips([clip.id]);
    expect(s().selectedClipId).toBe(clip.id);
    s().setSelectedClips([]);
    expect(s().selectedClipId).toBeNull();
    expect(s().selectedClipIds).toEqual([]);
  });
});
