import { describe, it, expect } from 'vitest';
import { collectSnapPoints, snapTime, snapMove } from './snapping';
import type { Clip, Project } from '../types';

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
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
    ...over,
  };
}

const project = {
  tracks: [{ clips: [makeClip({ id: 'a', timelineStartMs: 500, sourceOutMs: 1000 })] }],
  markers: [{ id: 'm', timeMs: 3000, label: '' }],
} as unknown as Project;

describe('collectSnapPoints', () => {
  it('includes origin, playhead, clip edges, markers and region corners', () => {
    const points = collectSnapPoints(project, [], 250, { startMs: 4000, endMs: 5000 });
    expect(points).toContain(0); // origin
    expect(points).toContain(250); // playhead
    expect(points).toContain(500); // clip start
    expect(points).toContain(1500); // clip end (500 + 1000)
    expect(points).toContain(3000); // marker
    expect(points).toContain(4000); // region start
    expect(points).toContain(5000); // region end
  });
  it('excludes edges of the dragged clips', () => {
    const points = collectSnapPoints(project, ['a'], 250, null);
    expect(points).not.toContain(500);
    expect(points).not.toContain(1500);
  });
});

describe('snapTime', () => {
  it('snaps to the nearest point within the threshold', () => {
    expect(snapTime(105, [100, 200], 10)).toBe(100);
  });
  it('leaves the value unchanged outside the threshold', () => {
    expect(snapTime(120, [100, 200], 10)).toBe(120);
  });
});

describe('snapMove', () => {
  it('snaps the moving start edge', () => {
    expect(snapMove(103, 500, [100], 10)).toBe(100);
  });
  it('snaps the moving end edge back to a start position', () => {
    // end at 603 is 3ms from point 600 → start snaps to 100
    expect(snapMove(103, 500, [600], 10)).toBe(100);
  });
});
