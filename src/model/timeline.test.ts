import { describe, expect, it } from 'vitest';
import { supersededCueIds } from './timeline';
import type { Clip, Project, Track } from '../types';

/**
 * What a regenerated caption pass is allowed to consider redundant. The rule
 * decides whether a second run replaces the first one or piles a second lane of
 * cues on top of it, so the boundary cases are the whole subject.
 */

function text(id: string, startMs: number, endMs: number, trackId: string): Clip {
  return {
    kind: 'text',
    id,
    assetId: '',
    trackId,
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: endMs - startMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.8, scale: 1 },
    text: { content: id, color: '#ffffff', sizeFrac: 0.05 },
  };
}

function media(id: string, startMs: number, endMs: number, trackId: string): Clip {
  return {
    kind: 'media',
    id,
    assetId: 'a1',
    trackId,
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: endMs - startMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
}

function project(...tracks: Track[]): Project {
  return { id: 'p', aspectRatio: '16:9', fps: 30, markers: [], tracks };
}

const lane = (id: string, clips: Clip[]): Track => ({ id, kind: 'video', clips });

describe('supersededCueIds', () => {
  it('finds the cues overlapping the span about to be transcribed', () => {
    const p = project(
      lane('captions', [
        text('early', 0, 900, 'captions'),
        text('inside', 1000, 2000, 'captions'),
        text('late', 5000, 6000, 'captions'),
      ]),
    );
    expect(supersededCueIds(p, 1000, 3000)).toEqual(['inside']);
  });

  it('leaves a cue that only touches the boundary alone', () => {
    // A cue ending exactly where the span starts shares no frame with it.
    const p = project(lane('captions', [text('before', 0, 1000, 'captions')]));
    expect(supersededCueIds(p, 1000, 3000)).toEqual([]);
  });

  it('spares a title card sharing its lane with footage', () => {
    // The whole-lane test is the only thing standing between a regeneration and
    // someone's opening title.
    const p = project(
      lane('mixed', [media('shot', 0, 5000, 'mixed'), text('title', 500, 1500, 'mixed')]),
    );
    expect(supersededCueIds(p, 0, 5000)).toEqual([]);
  });

  it('collects cues across several caption lanes', () => {
    const p = project(
      lane('fr', [text('fr1', 0, 1000, 'fr')]),
      lane('en', [text('en1', 0, 1000, 'en')]),
    );
    expect(supersededCueIds(p, 0, 1000).sort()).toEqual(['en1', 'fr1']);
  });
});
