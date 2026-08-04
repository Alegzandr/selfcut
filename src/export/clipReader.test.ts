import { describe, expect, it } from 'vitest';
import type { VideoSample, VideoSampleSink } from 'mediabunny';
import { ClipReader } from './clipReader';
import { timelineToSourceMs } from '../model';
import type { Clip } from '../types';

/**
 * A source frame stands in for a `VideoSample`: the reader only ever reads
 * `timestamp` and calls `clone()`/`close()`, so an index and a timestamp are
 * the whole contract. `index` is what the assertions compare - it identifies
 * which source frame the render would have painted.
 */
function fakeSample(index: number, timestamp: number): VideoSample {
  const sample = { index, timestamp, close: () => {} } as unknown as VideoSample;
  (sample as unknown as { clone: () => VideoSample }).clone = () => sample;
  return sample;
}

/**
 * A sink whose frames sit on an exact `pts / timescale` grid, the way a real
 * demuxer reports them - the floating-point shape that matters here. `samples()`
 * starts at the frame covering the requested instant, like mediabunny's.
 */
function fakeSink(fps: number, timescale: number, count: number): VideoSampleSink {
  const step = timescale / fps;
  const tsOf = (k: number) => Math.round(k * step) / timescale;
  return {
    async *samples(startSec: number) {
      let first = 0;
      while (first + 1 < count && tsOf(first + 1) <= startSec) first++;
      for (let k = first; k < count; k++) yield fakeSample(k, tsOf(k));
    },
  } as unknown as VideoSampleSink;
}

function mediaClip(sourceInMs: number): Clip {
  return {
    id: 'c1',
    kind: 'media',
    assetId: 'a1',
    timelineStartMs: 0,
    sourceInMs,
    sourceOutMs: sourceInMs + 10_000,
    speed: 1,
  } as unknown as Clip;
}

/**
 * Walk a clip exactly as `exportMp4` does - output time built in milliseconds,
 * mapped through `timelineToSourceMs` - and collect the source frame index each
 * output frame lands on.
 */
async function renderIndices(clip: Clip, sink: VideoSampleSink, outFps: number, frames: number) {
  const reader = new ClipReader(clip, async () => sink);
  const picked: number[] = [];
  for (let i = 0; i < frames; i++) {
    const tMs = (i * 1000) / outFps;
    const sample = await reader.frameAt(timelineToSourceMs(clip, tMs) / 1000);
    picked.push((sample as unknown as { index: number } | null)?.index ?? -1);
  }
  await reader.close();
  return picked;
}

describe('ClipReader.frameAt', () => {
  /**
   * The regression: exporting 120 fps footage at 120 fps used to repeat frames
   * and skip their neighbours, because an output instant computed in ms can
   * land a few ulps below the source timestamp it should match. The result was
   * a true 120 fps file that looked less fluid than the source.
   */
  it('advances one source frame per output frame at a matching rate', async () => {
    for (const timescale of [12_000, 120_000, 90_000, 1_000_000]) {
      const sink = fakeSink(120, timescale, 400);
      const picked = await renderIndices(mediaClip(0), sink, 120, 240);
      expect(picked, `timescale ${timescale}`).toEqual(
        Array.from({ length: 240 }, (_, i) => i),
      );
    }
  });

  /** Same, from a trimmed clip: the cut shifts the phase but must not drop frames. */
  it('advances one source frame per output frame from a trimmed clip', async () => {
    const frameMs = 1000 / 60;
    for (let cut = 0; cut < 8; cut++) {
      const sourceInMs = cut * frameMs;
      const sink = fakeSink(120, 120_000, 800);
      const picked = await renderIndices(mediaClip(sourceInMs), sink, 120, 240);
      const first = picked[0]!;
      expect(picked, `cut at frame ${cut}`).toEqual(
        Array.from({ length: 240 }, (_, i) => first + i),
      );
    }
  });

  /** Exporting 60 fps footage at 120 shows each source frame exactly twice. */
  it('doubles each source frame when the output rate is twice the source rate', async () => {
    const sink = fakeSink(60, 60_000, 200);
    const picked = await renderIndices(mediaClip(0), sink, 120, 120);
    expect(picked).toEqual(Array.from({ length: 120 }, (_, i) => Math.floor(i / 2)));
  });

  /** Exporting 120 fps footage at 60 keeps every other source frame - no stutter. */
  it('takes every other source frame when the output rate is half the source rate', async () => {
    const sink = fakeSink(120, 120_000, 400);
    const picked = await renderIndices(mediaClip(0), sink, 60, 120);
    expect(picked).toEqual(Array.from({ length: 120 }, (_, i) => i * 2));
  });

  /** Past the last decoded frame the clip holds on it rather than going black. */
  it('holds the final frame past the end of the source', async () => {
    const sink = fakeSink(120, 120_000, 5);
    const picked = await renderIndices(mediaClip(0), sink, 120, 8);
    expect(picked).toEqual([0, 1, 2, 3, 4, 4, 4, 4]);
  });
});
