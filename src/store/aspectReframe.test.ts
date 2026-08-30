import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';

/**
 * Changing the output ratio reframes the timeline with it: a plain ratio switch
 * fills the new frame, Shift (and the toast's toggle) letterboxes instead, and
 * neither ever overwrites a clip the user framed by hand.
 *
 * Store imported dynamically for the same reason as `linking.test.ts`: i18n
 * touches `document` at load time and these run in the node environment.
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, width = 1920, height = 1080): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs: 5000,
    width,
    height,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();

/** The single video clip on the timeline. */
function video() {
  return s().project.tracks.find((t) => t.kind === 'video')!.clips[0]!;
}

beforeEach(() => {
  s().resetProject();
  s().addAsset(videoAsset('v'));
  s().addClipFromAsset('v');
});

describe('setAspectRatio', () => {
  it('fills the new frame by default', () => {
    const reframed = s().setAspectRatio('9:16');
    expect(reframed).toBe(1);
    expect(video().transform!.scale).toBeCloseTo(3.1605, 3);
  });

  it('letterboxes when asked to fit', () => {
    s().setAspectRatio('9:16');
    expect(s().setAspectRatio('9:16', 'fit')).toBe(1);
    expect(video().transform!.scale).toBe(1);
  });

  it('keeps filling across successive ratio changes', () => {
    s().setAspectRatio('9:16');
    s().setAspectRatio('1:1');
    expect(video().transform!.scale).toBeCloseTo(16 / 9, 3);
  });

  it('never touches a clip the user framed by hand', () => {
    const id = video().id;
    s().updateClipCommitted(id, {
      transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.25, y: 0.5, scale: 1.4 },
    });
    expect(s().setAspectRatio('9:16')).toBe(0);
    expect(video().transform).toMatchObject({ x: 0.25, scale: 1.4 });
  });

  it('undoes the ratio and every scale it wrote in one step', () => {
    s().setAspectRatio('9:16');
    s().undo();
    expect(s().project.aspectRatio).toBe('16:9');
    expect(video().transform?.scale ?? 1).toBe(1);
  });

  it('reports nothing reframed when the frame ratio does not change the fit', () => {
    // 1080x1080 source, square output: it already covers, at either ratio.
    s().resetProject();
    s().addAsset(videoAsset('sq', 1080, 1080));
    s().addClipFromAsset('sq');
    s().setAspectRatio('1:1');
    expect(s().setAspectRatio('1:1')).toBe(0);
  });
});
