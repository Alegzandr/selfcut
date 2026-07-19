import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';

/**
 * Selection-wide editing and track locking. Both exist because the two used to
 * disagree with each other: Delete acted on the whole selection while
 * copy/cut/duplicate silently acted on one clip, and nothing could be frozen.
 *
 * Store bootstrapped like linking.test.ts: node environment, document stubbed.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, durationMs = 5000): MediaAsset {
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
  };
}

const s = () => useStore.getState();
const videoTrack = () => s().project.tracks.find((t) => t.kind === 'video')!;
const clips = () => videoTrack().clips;

beforeEach(() => {
  s().resetProject();
  // Three silent clips laid end to end on one video track.
  for (const id of ['a', 'b', 'c']) {
    s().addAsset(videoAsset(id));
    s().addClipFromAsset(id);
  }
});

describe('clipboard over a multi-selection', () => {
  it('copies every selected clip and pastes them keeping their spacing', () => {
    const [first, second] = clips();
    const gap = second!.timelineStartMs - first!.timelineStartMs;

    s().setSelectedClips([first!.id, second!.id]);
    s().copyClips(s().selectedClipIds);
    // Past the last clip, so the paste lands on empty timeline and no overlap
    // resolution moves it. `seek` clamps to the project duration, so read back
    // where the playhead actually ended up rather than assuming.
    s().seek(Number.MAX_SAFE_INTEGER);
    const at = s().currentTimeMs;
    s().pasteAtPlayhead();

    expect(clips()).toHaveLength(5);
    const pasted = s().selectedClipIds.map((id) => clips().find((c) => c.id === id)!);
    expect(pasted).toHaveLength(2);
    const starts = pasted.map((c) => c.timelineStartMs).sort((x, y) => x - y);
    expect(starts[0]).toBe(at);
    // The offset between the two survives the round-trip.
    expect(starts[1]! - starts[0]!).toBe(gap);
  });

  it('cut removes the whole selection, not just the primary clip', () => {
    const [first, second] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    s().cutClips(s().selectedClipIds);
    expect(clips()).toHaveLength(1);
  });

  it('duplicates every selected clip', () => {
    const [first, second] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    s().duplicateClips(s().selectedClipIds);
    expect(clips()).toHaveLength(5);
    expect(s().selectedClipIds).toHaveLength(2);
  });
});

describe('track lock', () => {
  it('refuses to select clips on a locked track', () => {
    const target = clips()[0]!.id;
    s().toggleTrackLocked(videoTrack().id);

    s().selectClip(target);
    expect(s().selectedClipIds).toEqual([]);
    s().toggleSelectClip(target);
    expect(s().selectedClipIds).toEqual([]);
    s().selectAllClips();
    expect(s().selectedClipIds).toEqual([]);
  });

  it('drops a live selection when the track is locked under it', () => {
    s().setSelectedClips(clips().map((c) => c.id));
    expect(s().selectedClipIds.length).toBe(3);

    s().toggleTrackLocked(videoTrack().id);
    expect(s().selectedClipIds).toEqual([]);
    expect(s().selectedClipId).toBeNull();
  });

  it('restores normal selection once unlocked', () => {
    const id = videoTrack().id;
    s().toggleTrackLocked(id);
    s().toggleTrackLocked(id);
    s().selectAllClips();
    expect(s().selectedClipIds).toHaveLength(3);
  });

  it('sends a newly imported clip to a free track rather than the locked one', () => {
    const lockedId = videoTrack().id;
    s().toggleTrackLocked(lockedId);
    s().addAsset(videoAsset('d'));
    s().addClipFromAsset('d');

    // The locked lane keeps exactly the three clips it had.
    expect(s().project.tracks.find((t) => t.id === lockedId)!.clips).toHaveLength(3);
  });
});
