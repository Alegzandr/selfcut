import { describe, it, expect } from 'vitest';
import { resolveOverlaps, findClip, insertTrack, createEmptyProject } from './projectOps';
import type { MediaClip, Project, Track } from '../types';

function clip(over: Partial<MediaClip> & { id: string }): MediaClip {
  return {
    kind: 'media',
    assetId: 'a',
    trackId: 't1',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 1000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  };
}

function project(tracks: Track[]): Project {
  return { id: 'p', aspectRatio: '16:9', fps: 60, tracks, markers: [] };
}

describe('resolveOverlaps', () => {
  it('keeps a partial overlap (crossfade) untouched', () => {
    const a = clip({ id: 'a', timelineStartMs: 0, sourceOutMs: 1000 });
    const b = clip({ id: 'b', timelineStartMs: 500, sourceOutMs: 1000 });
    const p = project([{ id: 't1', kind: 'video', clips: [a, b] }]);
    const out = resolveOverlaps(p);
    expect(out.tracks[0]!.clips.map((c) => c.timelineStartMs)).toEqual([0, 500]);
  });

  it('pushes a clip that starts within the minimum gap of its predecessor', () => {
    const a = clip({ id: 'a', timelineStartMs: 0, sourceOutMs: 1000 });
    const b = clip({ id: 'b', timelineStartMs: 50, sourceOutMs: 1000 });
    const p = project([{ id: 't1', kind: 'video', clips: [a, b] }]);
    const out = resolveOverlaps(p);
    const bStart = out.tracks[0]!.clips.find((c) => c.id === 'b')!.timelineStartMs;
    expect(bStart).toBe(100); // MIN_CLIP_DURATION_MS
  });

  it('returns the same reference when nothing moves', () => {
    const p = project([{ id: 't1', kind: 'video', clips: [clip({ id: 'a' })] }]);
    expect(resolveOverlaps(p)).toBe(p);
  });
});

describe('insertTrack', () => {
  it('inserts a video track right after the last video track', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [] },
      { id: 'a1', kind: 'audio', clips: [] },
    ]);
    insertTrack(p, { id: 'v2', kind: 'video', clips: [] });
    expect(p.tracks.map((t) => t.id)).toEqual(['v1', 'v2', 'a1']);
  });

  it('appends an audio track at the end', () => {
    const p = project([{ id: 'v1', kind: 'video', clips: [] }]);
    insertTrack(p, { id: 'a1', kind: 'audio', clips: [] });
    expect(p.tracks.map((t) => t.id)).toEqual(['v1', 'a1']);
  });
});

describe('findClip', () => {
  it('locates a clip with its track and index', () => {
    const p = project([
      { id: 't1', kind: 'video', clips: [clip({ id: 'a' }), clip({ id: 'b' })] },
    ]);
    const found = findClip(p, 'b');
    expect(found?.index).toBe(1);
    expect(found?.track.id).toBe('t1');
    expect(findClip(p, 'missing')).toBeNull();
  });
});

describe('createEmptyProject', () => {
  it('starts with no tracks and an empty marker list', () => {
    const p = createEmptyProject();
    expect(p.tracks).toEqual([]);
    expect(p.markers).toEqual([]);
  });
});
