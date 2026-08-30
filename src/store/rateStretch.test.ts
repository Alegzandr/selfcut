import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';

/**
 * Rate stretch (Ctrl+drag on a trim handle): dragging an edge changes the
 * clip's SPEED instead of cutting frames - the whole source window still plays,
 * over whatever span the pointer asks for.
 *
 * The store is imported dynamically, like the other pure-logic suites: its i18n
 * dependency touches `document` at load time.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

const s = () => useStore.getState();
const clips = () => s().project.tracks.flatMap((t) => t.clips);
const videoClip = () =>
  s()
    .project.tracks.filter((t) => t.kind === 'video')
    .flatMap((t) => t.clips)[0]!;

function videoAsset(id: string, durationMs = 4000, hasAudio = false): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio,
    audioTracks: hasAudio ? [{ index: 0, channels: 2 }] : [],
    thumbnails: [],
  };
}

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('v'));
  s().addClipFromAsset('v');
});

describe('stretchClip', () => {
  it('halves the speed when the right edge is dragged to twice the length', () => {
    const clip = videoClip();
    s().stretchClip(clip.id, 'right', clip.timelineStartMs + 8000);
    const next = videoClip();
    expect(next.speed).toBeCloseTo(0.5);
    // Not a trim: the source window is untouched, the clip just takes longer.
    expect(next.sourceInMs).toBe(clip.sourceInMs);
    expect(next.sourceOutMs).toBe(clip.sourceOutMs);
    expect(next.timelineStartMs).toBe(clip.timelineStartMs);
  });

  it('doubles the speed when the right edge is dragged to half the length', () => {
    const clip = videoClip();
    s().stretchClip(clip.id, 'right', clip.timelineStartMs + 2000);
    expect(videoClip().speed).toBeCloseTo(2);
  });

  it('pins the clip end when the left edge is stretched', () => {
    const clip = videoClip();
    s().moveClip(clip.id, 5000);
    const end = 5000 + 4000;
    s().stretchClip(clip.id, 'left', 1000);
    const next = videoClip();
    expect(next.speed).toBeCloseTo(0.5);
    expect(next.timelineStartMs).toBeCloseTo(1000);
    const nextEnd = next.timelineStartMs + (next.sourceOutMs - next.sourceInMs) / next.speed;
    expect(nextEnd).toBeCloseTo(end);
  });

  it('clamps to the speed bounds', () => {
    const clip = videoClip();
    s().stretchClip(clip.id, 'right', clip.timelineStartMs + 1);
    expect(videoClip().speed).toBe(8);
    s().stretchClip(videoClip().id, 'right', clip.timelineStartMs + 10_000_000);
    expect(videoClip().speed).toBe(0.1);
  });

  it('scales the keyframes so the animation follows the picture', () => {
    const clip = videoClip();
    s().updateClip(clip.id, {
      animation: { opacity: [{ t: 0, value: 0 }, { t: 2000, value: 1 }] },
    });
    s().stretchClip(clip.id, 'right', clip.timelineStartMs + 8000);
    expect(videoClip().animation?.opacity?.map((k) => k.t)).toEqual([0, 4000]);
  });

  it('scales the fades with the new length', () => {
    const clip = videoClip();
    s().updateClip(clip.id, { fadeInMs: 500, fadeOutMs: 500 });
    s().stretchClip(clip.id, 'right', clip.timelineStartMs + 8000);
    expect(videoClip().fadeInMs).toBeCloseTo(1000);
    expect(videoClip().fadeOutMs).toBeCloseTo(1000);
  });

  it('takes the linked audio partner along at the same speed', () => {
    s().resetProject();
    s().addAsset(videoAsset('av', 4000, true));
    s().addClipFromAsset('av');
    const video = videoClip();
    s().stretchClip(video.id, 'right', video.timelineStartMs + 8000);
    expect(clips().every((c) => Math.abs(c.speed - 0.5) < 1e-6)).toBe(true);
  });

  it('leaves a still alone - a stretch has no meaning without a media clock', () => {
    s().resetProject();
    s().addAsset({
      id: 'img',
      file: new File([], 'img.png'),
      kind: 'image',
      durationMs: 0,
      width: 800,
      height: 600,
      hasAudio: false,
      audioTracks: [],
      thumbnails: [],
    });
    s().addClipFromAsset('img');
    const clip = videoClip();
    s().stretchClip(clip.id, 'right', clip.timelineStartMs + 20_000);
    expect(videoClip().speed).toBe(1);
  });
});
