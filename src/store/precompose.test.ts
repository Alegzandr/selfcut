import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { clipEndMs, compDurationMs, isCompClip, tracksOf } from '../model';

/**
 * Pre-composition, end to end through the store: wrapping a selection, stepping
 * in and out, editing inside, and dissolving it back.
 *
 * The one invariant every case here is really about: the cut looks the same the
 * instant after precomposing as it did the instant before. Everything else
 * (where the clips land inside, what the parent is left holding, which lanes
 * survive) follows from that.
 *
 * The store is imported dynamically because its i18n dependency touches
 * `document` at load time - same as the other store suites.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

/** A silent video, so a clip stays on one lane and the assertions read plainly. */
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
const lanes = () => tracksOf(s().project, s().activeCompId);
const clips = () => lanes().flatMap((t) => t.clips);

beforeEach(() => {
  s().resetProject();
  s().openComp(null);
  s().addAsset(silentVideo('v'));
});

/** Two clips back to back on the video lane, selected. */
function twoShots(): string[] {
  s().addClipFromAsset('v');
  s().addClipFromAsset('v');
  const ids = clips().map((c) => c.id);
  s().setSelectedClips(ids);
  return ids;
}

describe('precompose', () => {
  it('replaces the selection with one clip that starts where it did', () => {
    const ids = twoShots();
    const wasFrom = Math.min(...clips().map((c) => c.timelineStartMs));
    const wasTo = Math.max(...clips().map(clipEndMs));

    const compId = s().precompose(ids);
    expect(compId).toBeTruthy();

    const out = clips();
    expect(out).toHaveLength(1);
    expect(isCompClip(out[0]!)).toBe(true);
    // The cut is unchanged: same start, same end, one layer instead of two.
    expect(out[0]!.timelineStartMs).toBeCloseTo(wasFrom, 6);
    expect(clipEndMs(out[0]!)).toBeCloseTo(wasTo, 6);
  });

  it('rebases the composition so its first clip starts at zero', () => {
    s().addClipFromAsset('v');
    const [first] = clips();
    s().updateClipCommitted(first!.id, { timelineStartMs: 4000 });
    s().setSelectedClips([first!.id]);

    const compId = s().precompose()!;
    const inside = tracksOf(s().project, compId).flatMap((t) => t.clips);
    // A precomp that opens with four seconds of nothing is a precomp whose every
    // trim is off by four seconds.
    expect(inside[0]!.timelineStartMs).toBe(0);
    expect(compDurationMs(s().project, compId)).toBeCloseTo(5000, 6);
    // ...and the layer that plays it still sits where the clip did.
    expect(clips()[0]!.timelineStartMs).toBeCloseTo(4000, 6);
  });

  it('keeps the lanes the selection spanned, in order', () => {
    s().addClipFromAsset('v');
    s().addTrack('video');
    const extra = lanes().find((t) => t.clips.length === 0)!;
    s().addClipFromAssetAt('v', 0, extra.id);
    s().setSelectedClips(clips().map((c) => c.id));

    const compId = s().precompose()!;
    expect(tracksOf(s().project, compId)).toHaveLength(2);
  });

  it('drops the lanes it emptied, but never the one it lands on', () => {
    s().addClipFromAsset('v');
    s().addTrack('video');
    const extra = lanes().find((t) => t.clips.length === 0)!;
    s().addClipFromAssetAt('v', 0, extra.id);
    const before = lanes().length;
    s().setSelectedClips(clips().map((c) => c.id));

    s().precompose();
    expect(lanes().length).toBeLessThan(before);
    expect(clips()).toHaveLength(1);
  });

  it('selects the clip it created', () => {
    const ids = twoShots();
    s().precompose(ids);
    expect(s().selectedClipIds).toEqual([clips()[0]!.id]);
  });

  it('does nothing with an empty selection', () => {
    s().addClipFromAsset('v');
    s().setSelectedClips([]);
    expect(s().precompose()).toBeNull();
    expect(s().project.comps).toHaveLength(0);
  });

  it('names each composition apart', () => {
    const a = s().precompose(twoShots())!;
    s().addClipFromAsset('v');
    s().setSelectedClips([clips()[clips().length - 1]!.id]);
    const b = s().precompose()!;
    const names = s().project.comps!.map((c) => c.name);
    expect(new Set(names).size).toBe(2);
    expect(a).not.toBe(b);
  });
});

describe('navigation', () => {
  it('swaps the timeline for the composition s own', () => {
    const compId = s().precompose(twoShots())!;
    s().openComp(compId);
    expect(s().activeCompId).toBe(compId);
    expect(clips()).toHaveLength(2);
    s().openComp(null);
    expect(clips()).toHaveLength(1);
  });

  it('drops the selection on the way in and out', () => {
    const compId = s().precompose(twoShots())!;
    expect(s().selectedClipIds).toHaveLength(1);
    s().openComp(compId);
    // A selection is a set of clips on ONE timeline: carried across, the
    // inspector would be editing something the user can no longer see.
    expect(s().selectedClipIds).toEqual([]);
  });

  it('remembers the playhead on each side', () => {
    const compId = s().precompose(twoShots())!;
    s().seek(3000);
    s().openComp(compId);
    s().seek(500);
    s().openComp(null);
    expect(s().currentTimeMs).toBeCloseTo(3000, 6);
    s().openComp(compId);
    expect(s().currentTimeMs).toBeCloseTo(500, 6);
  });

  it('refuses to open a composition that is gone', () => {
    s().openComp('nope');
    expect(s().activeCompId).toBeNull();
  });

  it('walks to the clip a reveal names, wherever it lives', () => {
    const compId = s().precompose(twoShots())!;
    const inner = tracksOf(s().project, compId).flatMap((t) => t.clips)[1]!;
    s().revealClip(inner.id);
    expect(s().activeCompId).toBe(compId);
    expect(s().selectedClipIds).toEqual([inner.id]);
  });
});

describe('editing inside a composition', () => {
  it('lands on the composition s lanes, not the project s', () => {
    const compId = s().precompose(twoShots())!;
    s().openComp(compId);
    const rootBefore = s().project.tracks.length;
    const compBefore = tracksOf(s().project, compId).length;
    s().addTrack('video');
    expect(tracksOf(s().project, compId).length).toBe(compBefore + 1);
    expect(s().project.tracks.length).toBe(rootBefore);
  });

  it('grows the clip that plays it when the composition gets longer', () => {
    const compId = s().precompose(twoShots())!;
    const was = clips()[0]!.sourceOutMs;
    s().openComp(compId);
    s().addClipFromAsset('v');
    s().openComp(null);
    // Nobody trimmed the comp clip, so the shot just added must not be cut off.
    expect(clips()[0]!.sourceOutMs).toBeGreaterThan(was);
    expect(clips()[0]!.sourceOutMs).toBeCloseTo(compDurationMs(s().project, compId), 6);
  });
});

describe('nesting', () => {
  it('wraps a comp clip in another composition', () => {
    const inner = s().precompose(twoShots())!;
    s().setSelectedClips([clips()[0]!.id]);
    const outer = s().precompose()!;
    expect(clips()).toHaveLength(1);
    const insideOuter = tracksOf(s().project, outer).flatMap((t) => t.clips);
    expect(insideOuter).toHaveLength(1);
    expect(isCompClip(insideOuter[0]!) && insideOuter[0]!.compId).toBe(inner);
  });

  it('refuses to put a composition inside itself', () => {
    const compId = s().precompose(twoShots())!;
    s().openComp(compId);
    s().addCompClip(compId);
    expect(clips().some(isCompClip)).toBe(false);
    expect(s().notice).toBeTruthy();
  });
});

describe('decompose', () => {
  it('puts the clips back where they were playing', () => {
    const ids = twoShots();
    const was = clips()
      .map((c) => ({ start: c.timelineStartMs, end: clipEndMs(c) }))
      .sort((a, b) => a.start - b.start);
    s().precompose(ids);
    s().decompose(clips()[0]!.id);

    const out = clips()
      .map((c) => ({ start: c.timelineStartMs, end: clipEndMs(c) }))
      .sort((a, b) => a.start - b.start);
    expect(out).toHaveLength(2);
    expect(out[0]!.start).toBeCloseTo(was[0]!.start, 3);
    expect(out[1]!.end).toBeCloseTo(was[1]!.end, 3);
  });

  it('drops a composition nothing plays any more', () => {
    s().precompose(twoShots());
    s().decompose(clips()[0]!.id);
    expect(s().project.comps).toHaveLength(0);
  });

  it('keeps a composition still used elsewhere', () => {
    const compId = s().precompose(twoShots())!;
    s().addCompClip(compId);
    const first = clips().find((c) => isCompClip(c))!;
    s().decompose(first.id);
    expect(s().project.comps).toHaveLength(1);
  });

  it('reports the attributes it would drop', () => {
    s().precompose(twoShots());
    const id = clips()[0]!.id;
    expect(s().compAttributesLost(id)).toBe(false);
    s().updateClipCommitted(id, { fadeInMs: 400 });
    expect(s().compAttributesLost(id)).toBe(true);
  });
});

describe('removeComp', () => {
  it('takes every clip playing it with it', () => {
    const compId = s().precompose(twoShots())!;
    s().addCompClip(compId);
    expect(clips().filter(isCompClip)).toHaveLength(2);
    s().removeComp(compId);
    expect(clips()).toHaveLength(0);
    expect(s().project.comps).toHaveLength(0);
  });

  it('walks the editor back out of what it deleted', () => {
    const compId = s().precompose(twoShots())!;
    s().openComp(compId);
    s().removeComp(compId);
    expect(s().activeCompId).toBeNull();
  });
});

describe('duplicateComp', () => {
  it('copies the lanes with fresh ids and leaves the original alone', () => {
    const compId = s().precompose(twoShots())!;
    const copyId = s().duplicateComp(compId)!;
    const original = tracksOf(s().project, compId);
    const copy = tracksOf(s().project, copyId);
    expect(copy).toHaveLength(original.length);
    expect(copy[0]!.id).not.toBe(original[0]!.id);
    expect(copy[0]!.clips[0]!.id).not.toBe(original[0]!.clips[0]!.id);
    // Nothing plays the copy yet: duplicating a composition is not laying it down.
    expect(clips().filter(isCompClip)).toHaveLength(1);
  });
});
