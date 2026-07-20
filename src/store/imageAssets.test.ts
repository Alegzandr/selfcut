import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { NEW_TRACK_TARGET } from './projectOps';

/**
 * Still-image assets on the timeline: they land on video tracks, stretch
 * without a source-duration bound and have nothing to slip. Store
 * bootstrapped like linking.test.ts (node environment, stubbed DOM bits).
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown; structuredClone: typeof structuredClone };
  g.document ??= { documentElement: {} };
  g.structuredClone = (<T>(v: T): T => JSON.parse(JSON.stringify(v)) as T) as typeof structuredClone;
  ({ useStore } = await import('./store'));
});

function imageAsset(id: string, durationMs = 5000): MediaAsset {
  return {
    id,
    file: new File([], `${id}.png`),
    kind: 'image',
    durationMs,
    width: 800,
    height: 600,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();

const onlyClip = () => s().project.tracks.flatMap((t) => t.clips)[0]!;

beforeEach(() => {
  s().resetProject();
  s().addAsset(imageAsset('img'));
  s().addClipFromAsset('img');
});

describe('image assets', () => {
  it('land on a video track with the default duration and no linked audio', () => {
    const tracks = s().project.tracks;
    const videoTracks = tracks.filter((t) => t.kind === 'video');
    expect(videoTracks).toHaveLength(1);
    expect(videoTracks[0]!.clips).toHaveLength(1);
    expect(tracks.filter((t) => t.kind === 'audio')).toHaveLength(0);
    const clip = onlyClip();
    expect(clip.sourceOutMs - clip.sourceInMs).toBe(5000);
    expect(clip.linkId).toBeUndefined();
  });

  it('trim right past the default duration: a still stretches without bound', () => {
    const clip = onlyClip();
    s().trimClip(clip.id, 'right', clip.timelineStartMs + 20_000);
    expect(onlyClip().sourceOutMs).toBe(20_000);
  });

  it('slip is a no-op: a still always shows the same frame', () => {
    const clip = onlyClip();
    s().updateClip(clip.id, { sourceInMs: 0, sourceOutMs: 3000 });
    s().slipClip(clip.id, 1000);
    expect(onlyClip().sourceInMs).toBe(0);
    expect(onlyClip().sourceOutMs).toBe(3000);
  });

  it('drop at a time keeps working through addClipFromAssetAt', () => {
    s().addClipFromAssetAt('img', 2500);
    const clips = s().project.tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(2);
    expect(clips[1]!.timelineStartMs).toBe(2500);
  });

  it('drop with NEW_TRACK_TARGET creates a fresh track instead of reusing one', () => {
    s().addClipFromAssetAt('img', 1000, NEW_TRACK_TARGET);
    const videoTracks = s().project.tracks.filter((t) => t.kind === 'video');
    expect(videoTracks).toHaveLength(2);
    expect(videoTracks[1]!.clips).toHaveLength(1);
    expect(videoTracks[1]!.clips[0]!.timelineStartMs).toBe(1000);
  });
});
