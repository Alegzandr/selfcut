import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { FRAME_MS } from '../app/config';

/**
 * The razor's reach. A cut is legal on every frame of a clip but the first and
 * the last - anything stricter, and an editor pressing S right after a cut
 * point finds the key silently inert for several frames.
 *
 * The store is imported dynamically for the same reason as in linking.test.ts:
 * its i18n dependency touches `document` at load time.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

/** A silent video, so the split stays on one track and the assertions read plainly. */
function silentVideo(id: string, durationMs = 5000): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const clips = () => s().project.tracks.flatMap((t) => t.clips);

beforeEach(() => {
  s().resetProject();
  s().addAsset(silentVideo('v'));
  s().addClipFromAsset('v');
});

describe('splitAtPlayhead', () => {
  it('cuts one frame into the clip', () => {
    s().seek(FRAME_MS);
    s().splitAtPlayhead();

    const out = [...clips()].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    expect(out).toHaveLength(2);
    expect(out[0]!.sourceOutMs).toBeCloseTo(FRAME_MS, 6);
    // The right half stays where the razor put it: no shove from resolveOverlaps.
    expect(out[1]!.timelineStartMs).toBeCloseTo(FRAME_MS, 6);
    expect(out[1]!.sourceInMs).toBeCloseTo(FRAME_MS, 6);
  });

  it('cuts one frame before the end of the clip', () => {
    s().seek(5000 - FRAME_MS);
    s().splitAtPlayhead();
    expect(clips()).toHaveLength(2);
  });

  it('refuses a cut on the clip edges, which would leave an empty half', () => {
    s().seek(0);
    s().splitAtPlayhead();
    expect(clips()).toHaveLength(1);

    s().seek(5000);
    s().splitAtPlayhead();
    expect(clips()).toHaveLength(1);
  });
});
