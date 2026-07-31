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

function videoAsset(id: string, durationMs = 5000, audioTrackCount = 0): MediaAsset {
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

describe('property edits over a multi-selection', () => {
  it('commits a field onto every selected clip, and only those', () => {
    const [first, second, third] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    s().updateClipCommitted(first!.id, { volume: 0.25 });

    const after = clips();
    expect(after.find((c) => c.id === first!.id)!.volume).toBe(0.25);
    expect(after.find((c) => c.id === second!.id)!.volume).toBe(0.25);
    expect(after.find((c) => c.id === third!.id)!.volume).toBe(1);
  });

  it('spreads a live transform edit', () => {
    const [first, second] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    // The playhead has to sit inside a clip for it to take the edit, and the
    // three clips run back to back: seek into the second one's span.
    s().updateClipTransformLive(first!.id, { scale: 1.5 }, second!.timelineStartMs + 10);

    for (const id of [first!.id, second!.id]) {
      expect(clips().find((c) => c.id === id)!.transform?.scale).toBe(1.5);
    }
  });

  it('spreads a colour edit', () => {
    const [first, second] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    s().updateClipColorLive(first!.id, 'contrast', 0.4, 0);

    for (const id of [first!.id, second!.id]) {
      expect(clips().find((c) => c.id === id)!.color?.contrast).toBe(0.4);
    }
  });

  it('resolves a function patch against each clip it lands on', () => {
    const [first, second] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    // What the inspector's text/crop/effect controls do: the new value builds
    // on the clip being edited, never on the one the panel happens to show.
    s().updateClip(first!.id, (c) => ({ fadeInMs: c.timelineStartMs }));

    expect(clips().find((c) => c.id === first!.id)!.fadeInMs).toBe(first!.timelineStartMs);
    expect(clips().find((c) => c.id === second!.id)!.fadeInMs).toBe(second!.timelineStartMs);
  });

  it('animates the whole selection from one keyframe diamond', () => {
    const [first, second] = clips();
    s().setSelectedClips([first!.id, second!.id]);
    // Inside the first clip only: the second has no instant to key here, so it
    // must keep its animation rather than take a keyframe past its own edges.
    s().toggleClipKeyframe(first!.id, 'scale', 10);
    expect(clips().find((c) => c.id === first!.id)!.animation?.scale).toHaveLength(1);
    expect(clips().find((c) => c.id === second!.id)!.animation?.scale).toBeUndefined();

    // Under both: the diamond then keys the pair.
    s().toggleClipKeyframe(first!.id, 'scale', second!.timelineStartMs + 10);
    expect(clips().find((c) => c.id === second!.id)!.animation?.scale).toHaveLength(1);
  });

  it('leaves a single selection to the clip it names', () => {
    const [first, second] = clips();
    s().selectClip(first!.id);
    s().updateClipCommitted(first!.id, { volume: 0.5 });
    expect(clips().find((c) => c.id === second!.id)!.volume).toBe(1);
  });
});

describe('audio edits reaching each clip through its own linked partner', () => {
  it('spreads a volume change onto every selected clip audio side', () => {
    s().resetProject();
    for (const id of ['x', 'y']) {
      s().addAsset(videoAsset(id, 5000, 1));
      s().addClipFromAsset(id);
    }
    const video = videoTrack().clips;
    const audio = s().project.tracks.find((t) => t.kind === 'audio')!.clips;
    expect(video).toHaveLength(2);
    expect(audio).toHaveLength(2);

    // Both picture clips selected; the inspector's fader edits the audio
    // partner of the primary, which must carry the pair - not one lane twice.
    s().setSelectedClips(video.map((c) => c.id));
    const primaryAudio = audio.find((c) => c.linkId === video[1]!.linkId)!;
    s().updateClipCommitted(primaryAudio.id, { volume: 0.3 });

    const after = s().project.tracks.find((t) => t.kind === 'audio')!.clips;
    expect(after.map((c) => c.volume)).toEqual([0.3, 0.3]);
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
