import { describe, it, expect } from 'vitest';
import type { Clip, Composition, Project, Track } from '../types';
import { clipEndMs } from '../model';
import { flattenAudibleClips, sameAudioMix } from './audioMix';

/**
 * A composition's sound, projected onto the timeline that plays it.
 *
 * The mix schedules buffer sources against ONE clock, so a clip three precomps
 * deep has to be rewritten as a clip on the root timeline before anything can be
 * scheduled: its start moved, its rate the product of every speed above it, and
 * its trim cut back to the window the comp clip actually plays. Get any of those
 * wrong and the sound is heard at the wrong moment, at the wrong pitch, or past
 * the end of the layer that was supposed to contain it.
 */

function media(id: string, startMs: number, durMs: number, over: Partial<Clip> = {}): Clip {
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
    ...over,
  } as Clip;
}

function compClip(id: string, compId: string, startMs: number, over: Partial<Clip> = {}): Clip {
  return {
    kind: 'comp',
    id,
    compId,
    assetId: '',
    trackId: 't',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: 4000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  } as Clip;
}

function lane(id: string, clips: Clip[], over: Partial<Track> = {}): Track {
  return { id, kind: 'audio', clips: clips.map((c) => ({ ...c, trackId: id })), ...over };
}

function project(tracks: Track[], comps: Composition[] = []): Project {
  return { id: 'p', aspectRatio: '16:9', fps: 60, tracks, markers: [], comps };
}

/** One composition holding a single 4 s clip, played whole by one comp clip. */
function nested(over: Partial<Clip> = {}, inner: Partial<Clip> = {}): Project {
  return project(
    [lane('root', [compClip('layer', 'k', 1000, over)])],
    [{ id: 'k', name: 'K', markers: [], tracks: [lane('in', [media('inside', 0, 4000, inner)])] }],
  );
}

const flat = (p: Project) => flattenAudibleClips(p, 0, 60_000);

describe('flattenAudibleClips', () => {
  it('shifts a nested clip to where the layer plays it', () => {
    const [c] = flat(nested());
    expect(c!.timelineStartMs).toBe(1000);
    expect(clipEndMs(c!)).toBe(5000);
    expect(c!.speed).toBe(1);
  });

  it('keys the projection per instance so one composition can play twice', () => {
    const p = project(
      [lane('root', [compClip('a', 'k', 0), compClip('b', 'k', 10_000)])],
      [{ id: 'k', name: 'K', markers: [], tracks: [lane('in', [media('inside', 0, 4000)])] }],
    );
    const ids = flat(p).map((c) => c.id);
    // Both uses have to be scheduled: sharing one id would have the second find
    // the first one's chain and place nothing.
    expect(new Set(ids).size).toBe(2);
    expect(flat(p).map((c) => c.timelineStartMs)).toEqual([0, 10_000]);
  });

  it('multiplies the rates through the nesting', () => {
    // The layer runs at 2x, and the clip inside was already at 2x: four source
    // ms per timeline ms.
    const [c] = flat(nested({ speed: 2 }, { speed: 2 }));
    expect(c!.speed).toBe(4);
  });

  it('stretches the fades with the layer s rate', () => {
    const [c] = flat(nested({ speed: 2 }, { fadeInMs: 1000 }));
    // Half the wall-clock time at 2x, so the ramp is half as long.
    expect(c!.fadeInMs).toBe(500);
  });

  it('cuts a clip back to the window the layer plays', () => {
    // The layer plays only the first second of a four-second composition.
    const [c] = flat(nested({ sourceOutMs: 1000 }));
    expect(clipEndMs(c!)).toBe(2000);
    // The trim is on the SOURCE too: the scheduler places a segment once and
    // reads the clip's own in/out to decide how much of it to play.
    expect(c!.sourceOutMs).toBe(1000);
  });

  it('honours the layer s in point', () => {
    const [c] = flat(nested({ sourceInMs: 1000, sourceOutMs: 4000 }));
    expect(c!.timelineStartMs).toBe(1000);
    expect(c!.sourceInMs).toBe(1000);
  });

  it('drops a clip the layer never reaches', () => {
    const p = project(
      [lane('root', [compClip('layer', 'k', 0, { sourceOutMs: 500 })])],
      [
        {
          id: 'k',
          name: 'K',
          markers: [],
          tracks: [lane('in', [media('late', 2000, 1000)])],
        },
      ],
    );
    expect(flat(p)).toEqual([]);
  });

  it('silences a ramped layer, like it silences a ramped clip', () => {
    const ramped = nested({ velocity: [{ t: 0, value: 1 }, { t: 4000, value: 2 }] });
    expect(flat(ramped)).toEqual([]);
  });

  it('scopes mute and solo to the lanes they are on', () => {
    const p = project(
      [lane('root', [compClip('layer', 'k', 0)])],
      [
        {
          id: 'k',
          name: 'K',
          markers: [],
          tracks: [
            lane('a', [media('kept', 0, 1000)], { solo: true }),
            lane('b', [media('dropped', 0, 1000)]),
          ],
        },
      ],
    );
    // A lane soloed INSIDE the composition silences its neighbours in there and
    // nothing else.
    expect(flat(p).map((c) => c.id)).toEqual(['layer/kept']);
  });

  it('drops everything under a muted layer', () => {
    const p = project(
      [lane('root', [compClip('layer', 'k', 0)], { muted: true })],
      [{ id: 'k', name: 'K', markers: [], tracks: [lane('in', [media('inside', 0, 1000)])] }],
    );
    expect(flat(p)).toEqual([]);
  });
});

describe('sameAudioMix with compositions', () => {
  it('notices an edit made inside a composition', () => {
    const before = nested();
    const after = nested({}, { volume: 0.5 });
    // The edit is two levels down and the root timeline is untouched: without
    // walking the compositions, the preview would keep playing the old mix.
    expect(sameAudioMix(before, after)).toBe(false);
  });

  it('notices a layer being pointed at a different composition', () => {
    const before = nested();
    const after = nested();
    (after.tracks[0]!.clips[0] as { compId: string }).compId = 'other';
    expect(sameAudioMix(before, after)).toBe(false);
  });

  it('stays true when nothing about the sound changed', () => {
    expect(sameAudioMix(nested(), nested())).toBe(true);
  });
});
