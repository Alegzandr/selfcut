import { describe, it, expect } from 'vitest';
import {
  resolveOverlaps,
  findClip,
  insertTrack,
  createEmptyProject,
  linkedPartnerIds,
  withLinkedIds,
  linkCandidates,
  linkableSelection,
} from './projectOps';
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

  it('places a track at index 0 when `atTop` is set', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [] },
      { id: 'a1', kind: 'audio', clips: [] },
    ]);
    insertTrack(p, { id: 'v2', kind: 'video', clips: [] }, { atTop: true });
    expect(p.tracks.map((t) => t.id)).toEqual(['v2', 'v1', 'a1']);
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

describe('A/V link helpers', () => {
  const linked = () =>
    project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', linkId: 'L' })] },
      {
        id: 'a1',
        kind: 'audio',
        clips: [clip({ id: 'a', trackId: 'a1', linkId: 'L' }), clip({ id: 'solo', trackId: 'a1' })],
      },
    ]);

  it('finds the partner sharing a linkId across tracks', () => {
    expect(linkedPartnerIds(linked(), 'v')).toEqual(['a']);
    expect(linkedPartnerIds(linked(), 'a')).toEqual(['v']);
  });

  it('returns nothing for an unlinked clip', () => {
    expect(linkedPartnerIds(linked(), 'solo')).toEqual([]);
  });

  it('expands a selection to include linked partners, without duplicates', () => {
    expect(withLinkedIds(linked(), ['v']).sort()).toEqual(['a', 'v']);
    expect(withLinkedIds(linked(), ['v', 'a']).sort()).toEqual(['a', 'v']);
    expect(withLinkedIds(linked(), ['solo'])).toEqual(['solo']);
  });
});

describe('linkCandidates / linkableSelection', () => {
  // A video and its extracted audio (same asset 'a'), both unlinked, plus an
  // unrelated audio clip from a different source.
  const unpaired = () =>
    project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a', sourceOutMs: 4000 })] },
      {
        id: 'a1',
        kind: 'audio',
        clips: [
          clip({ id: 'a', trackId: 'a1', assetId: 'a', sourceOutMs: 4000 }),
          clip({ id: 'other', trackId: 'a1', assetId: 'b', timelineStartMs: 8000 }),
        ],
      },
    ]);

  // Same source split across two audio lanes, as a multi-stream import does.
  const multiLane = () =>
    project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a', sourceOutMs: 4000 })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'a', trackId: 'a1', assetId: 'a', sourceOutMs: 4000 })] },
      { id: 'a2', kind: 'audio', clips: [clip({ id: 'b', trackId: 'a2', assetId: 'a', sourceOutMs: 4000 })] },
    ]);

  it('pairs a clip with the same-asset clip on the opposite track', () => {
    expect(linkCandidates(unpaired(), 'v')).toEqual(['a']);
    expect(linkCandidates(unpaired(), 'a')).toEqual(['v']);
  });

  it('pairs a video with one candidate per audio lane', () => {
    expect(linkCandidates(multiLane(), 'v')).toEqual(['a', 'b']);
  });

  it('pairs an audio lane with a single video side', () => {
    expect(linkCandidates(multiLane(), 'a')).toEqual(['v']);
  });

  it('ignores a different-asset clip on the opposite track', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a' })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'other', trackId: 'a1', assetId: 'b' })] },
    ]);
    expect(linkCandidates(p, 'v')).toEqual([]);
  });

  it('offers no candidate for an already-linked clip', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a', linkId: 'L' })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'a', trackId: 'a1', assetId: 'a' })] },
    ]);
    expect(linkCandidates(p, 'v')).toEqual([]);
  });

  it('resolves a two-clip selection on opposite tracks', () => {
    expect(linkableSelection(unpaired(), ['v', 'a'])).toEqual(['v', 'a']);
  });

  it('accepts two clips on the same-kind track', () => {
    const p = project([
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'x', trackId: 'a1' }), clip({ id: 'y', trackId: 'a1', timelineStartMs: 2000 })] },
    ]);
    expect(linkableSelection(p, ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('resolves a video plus several audio lanes', () => {
    expect(linkableSelection(multiLane(), ['v', 'a', 'b'])).toEqual(['v', 'a', 'b']);
  });

  it('accepts a selection holding several video sides', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a' })] },
      { id: 'v2', kind: 'video', clips: [clip({ id: 'w', trackId: 'v2', assetId: 'a' })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'a', trackId: 'a1', assetId: 'a' })] },
    ]);
    expect(linkableSelection(p, ['v', 'w', 'a'])).toEqual(['v', 'w', 'a']);
  });

  it('adds a clip to an existing group, carrying its unselected members', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a', linkId: 'L' })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'a', trackId: 'a1', assetId: 'a', linkId: 'L' })] },
      { id: 'a2', kind: 'audio', clips: [clip({ id: 'b', trackId: 'a2', assetId: 'a' })] },
    ]);
    // 'v' stays in even though only 'a' and 'b' were selected.
    expect(new Set(linkableSelection(p, ['a', 'b']))).toEqual(new Set(['v', 'a', 'b']));
  });

  it('rejects a selection already wholly inside one group', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a', linkId: 'L' })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'a', trackId: 'a1', assetId: 'a', linkId: 'L' })] },
    ]);
    expect(linkableSelection(p, ['v', 'a'])).toBeNull();
  });

  it('refuses to merge two existing groups', () => {
    const p = project([
      { id: 'v1', kind: 'video', clips: [clip({ id: 'v', assetId: 'a', linkId: 'L' })] },
      { id: 'a1', kind: 'audio', clips: [clip({ id: 'a', trackId: 'a1', assetId: 'a', linkId: 'M' })] },
      { id: 'a2', kind: 'audio', clips: [clip({ id: 'b', trackId: 'a2', assetId: 'a' })] },
    ]);
    expect(linkableSelection(p, ['v', 'a', 'b'])).toBeNull();
  });

  it('auto-resolves a single-clip selection to its candidates', () => {
    expect(linkableSelection(unpaired(), ['v'])).toEqual(['v', 'a']);
    expect(linkableSelection(multiLane(), ['v'])).toEqual(['v', 'a', 'b']);
    expect(linkableSelection(unpaired(), ['other'])).toBeNull();
    expect(linkableSelection(unpaired(), [])).toBeNull();
  });
});

describe('createEmptyProject', () => {
  it('starts with no tracks and an empty marker list', () => {
    const p = createEmptyProject();
    expect(p.tracks).toEqual([]);
    expect(p.markers).toEqual([]);
  });
});
