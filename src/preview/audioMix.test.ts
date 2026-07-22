import { describe, it, expect } from 'vitest';
import type { Clip, Project, Track } from '../types';
import { sameAudioMix } from './audioMix';

/**
 * `sameAudioMix` decides whether the preview tears down and rebuilds its whole
 * Web Audio graph after an edit. Both directions are bugs:
 * - a false negative rebuilds the graph on a transform drag (~60 times a
 *   second, each re-anchoring playback 30 ms later - audible stutter);
 * - a false positive leaves the mix stale, so an edit to volume, timing or
 *   fades is simply not heard until playback is restarted by hand.
 *
 * The field list therefore has to track everything `scheduleProjectAudio` and
 * `scheduleClip` read. Each audio-relevant field gets a case below so that
 * dropping one from the comparison fails a test instead of shipping silence.
 */

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    kind: 'media',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  } as Clip;
}

function project(over: Partial<Track> = {}, clips: Clip[] = [clip()]): Project {
  const track: Track = { id: 't1', kind: 'audio', clips, ...over };
  return { id: 'p1', aspectRatio: '16:9', fps: 30, tracks: [track], markers: [] } as Project;
}

/** Same project with exactly one clip field changed, as an edit would produce. */
function edited(field: Partial<Clip>): [Project, Project] {
  return [project(), project({}, [clip(field)])];
}

describe('sameAudioMix', () => {
  it('is true for the identical object', () => {
    const p = project();
    expect(sameAudioMix(p, p)).toBe(true);
  });

  it('is true for a structurally identical copy', () => {
    expect(sameAudioMix(project(), project())).toBe(true);
  });

  describe('ignores edits that cannot change the sound', () => {
    it('transform (the preview drag/scale/crop path)', () => {
      const [a, b] = edited({
        transform: { x: 0.8, y: 0.2, scale: 2, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
      });
      expect(sameAudioMix(a, b)).toBe(true);
    });

    it('track opacity and visibility', () => {
      expect(sameAudioMix(project(), project({ opacity: 0.3, hidden: true }))).toBe(true);
    });
  });

  describe('detects edits that change the sound', () => {
    const cases: [string, Partial<Clip>][] = [
      ['volume', { volume: 0.5 }],
      ['timeline position', { timelineStartMs: 1000 }],
      ['source in point', { sourceInMs: 500 }],
      ['source out point', { sourceOutMs: 4000 }],
      ['speed', { speed: 2 }],
      ['fade in', { fadeInMs: 250 }],
      ['fade out', { fadeOutMs: 250 }],
      ['pan', { pan: -0.5 }],
      ['mono downmix', { mono: true }],
      ['asset', { assetId: 'a2' }],
      ['audio track index', { audioTrackIndex: 1 }],
      ['link membership', { linkId: 'l1' }],
      ['clip identity', { id: 'c2' }],
      ['audio effect added', { audioFx: [{ type: 'reverb', amount: 0.5 }] }],
    ];
    for (const [name, over] of cases) {
      it(name, () => {
        const [a, b] = edited(over);
        expect(sameAudioMix(a, b)).toBe(false);
      });
    }

    it('audio effect intensity', () => {
      const a = project({}, [clip({ audioFx: [{ type: 'reverb', amount: 0.3 }] })]);
      const b = project({}, [clip({ audioFx: [{ type: 'reverb', amount: 0.8 }] })]);
      expect(sameAudioMix(a, b)).toBe(false);
    });

    it('audio effect order', () => {
      const a = project({}, [
        clip({ audioFx: [{ type: 'voice', amount: 0.5 }, { type: 'reverb', amount: 0.5 }] }),
      ]);
      const b = project({}, [
        clip({ audioFx: [{ type: 'reverb', amount: 0.5 }, { type: 'voice', amount: 0.5 }] }),
      ]);
      expect(sameAudioMix(a, b)).toBe(false);
    });

    it('track mute', () => {
      expect(sameAudioMix(project(), project({ muted: true }))).toBe(false);
    });

    it('track volume', () => {
      expect(sameAudioMix(project(), project({ volume: 0.5 }))).toBe(false);
    });

    it('track kind (drives link delegation)', () => {
      expect(sameAudioMix(project(), project({ kind: 'video' }))).toBe(false);
    });

    it('clip added', () => {
      expect(sameAudioMix(project(), project({}, [clip(), clip({ id: 'c2' })]))).toBe(false);
    });

    it('clip removed', () => {
      expect(sameAudioMix(project({}, [clip(), clip({ id: 'c2' })]), project())).toBe(false);
    });

    it('track added', () => {
      const two = project();
      two.tracks = [...two.tracks, { id: 't2', kind: 'audio', clips: [] }];
      expect(sameAudioMix(project(), two)).toBe(false);
    });
  });
});
