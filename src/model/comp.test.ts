import { describe, it, expect } from 'vitest';
import type { Clip, Composition, Project, Track } from '../types';
import {
  compCarriesAudio,
  compDurationMs,
  compIdOfClip,
  compPath,
  compTimeAt,
  compUsages,
  findComp,
  forEachProjectClip,
  nestedCompIds,
  playsWholeComp,
  setTracksOf,
  syncCompClips,
  tracksHolding,
  tracksOf,
  uniqueCompName,
  wouldNest,
} from './comp';

/**
 * The tree derived from a FLAT list of compositions: what contains what, where
 * the editor is standing, and which comp clips have to follow a composition that
 * just changed length.
 *
 * Every one of these answers is derived rather than stored, which is what makes
 * a composition reusable in two places at once - and what makes it worth pinning
 * that the derivation is right.
 */

function clip(id: string, startMs: number, durMs: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'media',
    id,
    assetId: 'a',
    trackId: 't',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: durMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...extra,
  } as Clip;
}

function compClip(id: string, compId: string, startMs: number, durMs: number): Clip {
  return {
    kind: 'comp',
    id,
    compId,
    assetId: '',
    trackId: 't',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: durMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  } as Clip;
}

function lane(id: string, clips: Clip[], kind: Track['kind'] = 'video'): Track {
  return { id, kind, clips: clips.map((c) => ({ ...c, trackId: id })) };
}

function comp(id: string, name: string, tracks: Track[]): Composition {
  return { id, name, tracks, markers: [] };
}

function project(tracks: Track[], comps: Composition[] = []): Project {
  return { id: 'p', aspectRatio: '16:9', fps: 60, tracks, markers: [], comps };
}

describe('tracksOf / setTracksOf', () => {
  it('reads the project itself at the root and a composition by id', () => {
    const p = project([lane('t1', [clip('c1', 0, 1000)])], [comp('k', 'Intro', [lane('t2', [])])]);
    expect(tracksOf(p, null)).toBe(p.tracks);
    expect(tracksOf(p, 'k')).toBe(p.comps![0]!.tracks);
  });

  it('answers an empty stack for a composition that is gone', () => {
    // An undo can delete the composition the editor is standing in, and the
    // editor renders one more time before the navigation catches up.
    expect(tracksOf(project([]), 'missing')).toEqual([]);
  });

  it('writes back to the right stack', () => {
    const p = project([lane('t1', [])], [comp('k', 'Intro', [lane('t2', [])])]);
    const replacement = [lane('t3', [])];
    setTracksOf(p, 'k', replacement);
    expect(p.comps![0]!.tracks).toBe(replacement);
    expect(p.tracks).toHaveLength(1);
  });
});

describe('compDurationMs', () => {
  it('is the end of the last clip inside, not the project s', () => {
    const p = project(
      [lane('t1', [clip('c1', 0, 10_000)])],
      [comp('k', 'Intro', [lane('t2', [clip('c2', 500, 1000)])])],
    );
    expect(compDurationMs(p, null)).toBe(10_000);
    expect(compDurationMs(p, 'k')).toBe(1500);
  });
});

describe('wouldNest', () => {
  it('refuses a composition inside itself', () => {
    const p = project([], [comp('k', 'Intro', [])]);
    expect(wouldNest(p, 'k', 'k')).toBe(true);
  });

  it('refuses a composition inside one it already contains', () => {
    // outer holds inner; putting outer into inner would close the loop.
    const p = project(
      [],
      [comp('outer', 'Outer', [lane('t', [compClip('x', 'inner', 0, 1000)])]), comp('inner', 'Inner', [])],
    );
    expect(wouldNest(p, 'inner', 'outer')).toBe(true);
    expect(wouldNest(p, 'outer', 'inner')).toBe(false);
  });

  it('never refuses the root', () => {
    const p = project([], [comp('k', 'Intro', [])]);
    expect(wouldNest(p, null, 'k')).toBe(false);
  });

  it('survives a cycle that already exists in the data', () => {
    // Not reachable through the editor, but a hand-edited file could carry it
    // and the guard must terminate rather than recurse forever.
    const p = project(
      [],
      [
        comp('a', 'A', [lane('ta', [compClip('x', 'b', 0, 1000)])]),
        comp('b', 'B', [lane('tb', [compClip('y', 'a', 0, 1000)])]),
      ],
    );
    expect(nestedCompIds(p, 'a')).toEqual(new Set(['b', 'a']));
  });
});

describe('compPath', () => {
  it('walks from the root down to the open composition', () => {
    const p = project(
      [lane('t1', [compClip('x', 'outer', 0, 1000)])],
      [comp('outer', 'Outer', [lane('t2', [compClip('y', 'inner', 0, 500)])]), comp('inner', 'Inner', [])],
    );
    expect(compPath(p, 'inner', 'Main').map((c) => c.name)).toEqual(['Main', 'Outer', 'Inner']);
    expect(compPath(p, 'inner', 'Main')[1]!.viaClipId).toBe('x');
  });

  it('still places a composition nothing plays', () => {
    // Freshly created, or orphaned by a delete: the editor is standing in it and
    // has to be able to say so.
    const p = project([], [comp('k', 'Orphan', [])]);
    expect(compPath(p, 'k', 'Main').map((c) => c.name)).toEqual(['Main', 'Orphan']);
  });

  it('is one step at the root', () => {
    expect(compPath(project([]), null, 'Main')).toEqual([{ compId: null, name: 'Main' }]);
  });
});

describe('compUsages', () => {
  it('finds every clip playing a composition, wherever it lives', () => {
    const p = project(
      [lane('t1', [compClip('x', 'k', 0, 1000), compClip('y', 'k', 2000, 1000)])],
      [comp('k', 'Intro', []), comp('other', 'Other', [lane('t2', [compClip('z', 'k', 0, 1000)])])],
    );
    const uses = compUsages(p, 'k');
    expect(uses.map((u) => u.clipId).sort()).toEqual(['x', 'y', 'z']);
    expect(uses.find((u) => u.clipId === 'z')!.hostId).toBe('other');
  });
});

describe('compTimeAt', () => {
  it('maps parent time through the clip s trim and speed', () => {
    const c = compClip('x', 'k', 1000, 2000) as Extract<Clip, { kind: 'comp' }>;
    c.sourceInMs = 500;
    c.speed = 2;
    // 1000ms into the parent clip, at 2x, is 2000ms of composition past the in
    // point.
    expect(compTimeAt(c, 2000)).toBe(2500);
  });
});

describe('syncCompClips', () => {
  const before = () =>
    project(
      [lane('t1', [compClip('whole', 'k', 0, 1000), compClip('trimmed', 'k', 2000, 400)])],
      [comp('k', 'Intro', [lane('t2', [clip('c', 0, 1000)])])],
    );

  it('grows the clips that were playing the composition whole', () => {
    const prev = before();
    const next = before();
    next.comps![0]!.tracks[0]!.clips.push(clip('c2', 1000, 500));
    syncCompClips(prev, next);
    const clips = next.tracks[0]!.clips;
    expect(clips.find((c) => c.id === 'whole')!.sourceOutMs).toBe(1500);
    // A clip the user trimmed keeps its trim: the composition growing is not a
    // reason to undo an edit they made on purpose.
    expect(clips.find((c) => c.id === 'trimmed')!.sourceOutMs).toBe(400);
  });

  it('pulls a trim back when the composition shrinks under it', () => {
    const prev = before();
    const next = before();
    next.comps![0]!.tracks[0]!.clips[0]!.sourceOutMs = 300;
    syncCompClips(prev, next);
    const clips = next.tracks[0]!.clips;
    expect(clips.find((c) => c.id === 'whole')!.sourceOutMs).toBe(300);
    // 400 was inside the old composition and is past the end of the new one:
    // left alone it would play a black tail.
    expect(clips.find((c) => c.id === 'trimmed')!.sourceOutMs).toBe(300);
  });

  it('does nothing when no composition changed length', () => {
    const prev = before();
    const next = before();
    syncCompClips(prev, next);
    expect(next.tracks[0]!.clips.map((c) => c.sourceOutMs)).toEqual([1000, 400]);
  });
});

describe('playsWholeComp', () => {
  it('tolerates a sub-frame drift', () => {
    const c = compClip('x', 'k', 0, 1000.4) as Extract<Clip, { kind: 'comp' }>;
    expect(playsWholeComp(c, 1000)).toBe(true);
  });

  it('is false once the clip has been trimmed', () => {
    const c = compClip('x', 'k', 0, 600) as Extract<Clip, { kind: 'comp' }>;
    expect(playsWholeComp(c, 1000)).toBe(false);
  });
});

describe('compCarriesAudio', () => {
  const assets = { loud: { hasAudio: true }, mute: { hasAudio: false } };

  it('reaches through nesting', () => {
    const p = project(
      [],
      [
        comp('outer', 'Outer', [lane('t1', [compClip('x', 'inner', 0, 1000)])]),
        comp('inner', 'Inner', [lane('t2', [clip('c', 0, 1000, { assetId: 'loud' })])]),
      ],
    );
    expect(compCarriesAudio(p, 'outer', assets)).toBe(true);
  });

  it('is false for a composition of silent footage', () => {
    const p = project([], [comp('k', 'K', [lane('t', [clip('c', 0, 1000, { assetId: 'mute' })])])]);
    expect(compCarriesAudio(p, 'k', assets)).toBe(false);
  });
});

describe('locators', () => {
  it('finds which composition holds a clip, and its lanes', () => {
    const p = project(
      [lane('t1', [clip('root', 0, 1000)])],
      [comp('k', 'Intro', [lane('t2', [clip('nested', 0, 1000)])])],
    );
    expect(compIdOfClip(p, 'root')).toBe(null);
    expect(compIdOfClip(p, 'nested')).toBe('k');
    expect(compIdOfClip(p, 'gone')).toBe(undefined);
    expect(tracksHolding(p, 't2')).toBe(p.comps![0]!.tracks);
  });

  it('visits every clip in the project, precomps included', () => {
    const p = project(
      [lane('t1', [clip('root', 0, 1000)])],
      [comp('k', 'Intro', [lane('t2', [clip('nested', 0, 1000)])])],
    );
    const seen: string[] = [];
    forEachProjectClip(p, (c) => seen.push(c.id));
    expect(seen).toEqual(['root', 'nested']);
  });
});

describe('uniqueCompName', () => {
  it('numbers a name already taken', () => {
    const p = project([], [comp('a', 'Composition', []), comp('b', 'Composition 2', [])]);
    expect(uniqueCompName(p, 'Composition')).toBe('Composition 3');
    expect(uniqueCompName(p, 'Intro')).toBe('Intro');
  });
});

describe('findComp', () => {
  it('answers undefined rather than throwing for an id that is gone', () => {
    expect(findComp(project([]), 'nope')).toBeUndefined();
  });
});
