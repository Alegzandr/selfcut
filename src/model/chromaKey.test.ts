import { describe, expect, it } from 'vitest';
import { hexToRgb01, resolveColor } from './clip';
import type { MediaClip } from '../types';

function clip(color: MediaClip['color']): MediaClip {
  return {
    kind: 'media',
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 1000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    color,
  };
}

describe('hexToRgb01', () => {
  it('parses #rrggbb', () => {
    expect(hexToRgb01('#00ff00')).toEqual([0, 1, 0]);
    expect(hexToRgb01('#ffffff')).toEqual([1, 1, 1]);
  });

  it('parses shorthand #rgb', () => {
    expect(hexToRgb01('#0f0')).toEqual([0, 1, 0]);
  });

  it('falls back to green for anything unreadable', () => {
    expect(hexToRgb01('not-a-color')).toEqual([0, 1, 0]);
    expect(hexToRgb01('#12')).toEqual([0, 1, 0]);
  });
});

describe('resolveColor with chroma key', () => {
  it('is null when the clip has no grade at all', () => {
    expect(resolveColor(clip(undefined), 0)).toBeNull();
  });

  it('resolves the key even when no numeric grade is set', () => {
    const c = clip({ chromaKey: { color: '#00ff00', similarity: 0.4, smoothness: 0.1, spill: 0.5 } });
    const r = resolveColor(c, 0);
    expect(r).not.toBeNull();
    expect(r!.chroma).toEqual({
      color: [0, 1, 0],
      similarity: 0.4,
      smoothness: 0.1,
      spill: 0.5,
    });
  });
});
