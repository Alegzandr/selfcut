import { describe, it, expect } from 'vitest';
import {
  clipDurationMs,
  clipEndMs,
  timelineToSourceMs,
  projectDurationMs,
  clipEnvelopeGainAt,
  clipFadeGainAt,
  clipZoomAt,
  trackCrossfades,
  outputDimensions,
  sortedMarkers,
  isTextClip,
  isGeneratedClip,
  type Clip,
  type Project,
} from './types';

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

describe('clip timing', () => {
  it('duration divides source span by speed', () => {
    expect(clipDurationMs(makeClip({ sourceInMs: 0, sourceOutMs: 1000, speed: 1 }))).toBe(1000);
    expect(clipDurationMs(makeClip({ sourceInMs: 0, sourceOutMs: 1000, speed: 2 }))).toBe(500);
  });
  it('end adds duration to the timeline start', () => {
    expect(clipEndMs(makeClip({ timelineStartMs: 500, sourceOutMs: 1000 }))).toBe(1500);
  });
  it('timelineToSourceMs maps timeline back to source, honouring speed', () => {
    const clip = makeClip({ timelineStartMs: 1000, sourceInMs: 200, speed: 2 });
    expect(timelineToSourceMs(clip, 1000)).toBe(200);
    expect(timelineToSourceMs(clip, 1500)).toBe(1200);
  });
});

describe('projectDurationMs', () => {
  it('returns the end of the last-ending clip', () => {
    const project = {
      tracks: [
        { clips: [makeClip({ timelineStartMs: 0, sourceOutMs: 1000 })] },
        { clips: [makeClip({ timelineStartMs: 2000, sourceOutMs: 500 })] },
      ],
    } as unknown as Project;
    expect(projectDurationMs(project)).toBe(2500);
  });
  it('is zero for an empty project', () => {
    expect(projectDurationMs({ tracks: [] } as unknown as Project)).toBe(0);
  });
});

describe('clipEnvelopeGainAt', () => {
  const clip = makeClip({ timelineStartMs: 0, sourceOutMs: 1000, fadeInMs: 200, fadeOutMs: 200 });
  it('ramps up during the fade-in', () => {
    expect(clipEnvelopeGainAt(clip, 0, 0, 0)).toBe(0);
    expect(clipEnvelopeGainAt(clip, 100, 0, 0)).toBeCloseTo(0.5);
    expect(clipEnvelopeGainAt(clip, 200, 0, 0)).toBe(1);
  });
  it('ramps down during the fade-out', () => {
    expect(clipEnvelopeGainAt(clip, 900, 0, 0)).toBeCloseTo(0.5);
    expect(clipEnvelopeGainAt(clip, 1000, 0, 0)).toBe(0);
  });
  it('lets a crossfade window win over a shorter explicit fade', () => {
    const noFade = makeClip({ timelineStartMs: 0, sourceOutMs: 1000 });
    expect(clipEnvelopeGainAt(noFade, 200, 400, 0)).toBeCloseTo(0.5);
  });
  it('clipFadeGainAt matches the envelope with no crossfade', () => {
    expect(clipFadeGainAt(clip, 100)).toBeCloseTo(clipEnvelopeGainAt(clip, 100, 0, 0));
  });
});

describe('clipZoomAt', () => {
  it('is 1 when there is no zoom', () => {
    expect(clipZoomAt(makeClip(), 500)).toBe(1);
  });
  it('interpolates linearly from 1 to zoomEnd', () => {
    const clip = makeClip({ timelineStartMs: 0, sourceOutMs: 1000, zoomEnd: 2 });
    expect(clipZoomAt(clip, 0)).toBe(1);
    expect(clipZoomAt(clip, 500)).toBeCloseTo(1.5);
    expect(clipZoomAt(clip, 1000)).toBe(2);
  });
});

describe('trackCrossfades', () => {
  it('reports no crossfade for non-overlapping clips', () => {
    const a = makeClip({ id: 'a', timelineStartMs: 0, sourceOutMs: 1000 });
    const b = makeClip({ id: 'b', timelineStartMs: 1000, sourceOutMs: 1000 });
    const xf = trackCrossfades([a, b]);
    expect(xf.get('a')).toEqual({ inMs: 0, outMs: 0 });
    expect(xf.get('b')).toEqual({ inMs: 0, outMs: 0 });
  });
  it('derives a symmetric window from the overlap', () => {
    const a = makeClip({ id: 'a', timelineStartMs: 0, sourceOutMs: 1000 });
    const b = makeClip({ id: 'b', timelineStartMs: 800, sourceOutMs: 1000 });
    const xf = trackCrossfades([a, b]);
    expect(xf.get('a')!.outMs).toBe(200);
    expect(xf.get('b')!.inMs).toBe(200);
  });
});

describe('outputDimensions', () => {
  it('maps each aspect ratio to its export resolution', () => {
    expect(outputDimensions('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(outputDimensions('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(outputDimensions('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(outputDimensions('4:5')).toEqual({ width: 1080, height: 1350 });
  });
});

describe('sortedMarkers', () => {
  it('orders markers by time', () => {
    const project = {
      markers: [
        { id: 'm2', timeMs: 2000, label: '' },
        { id: 'm1', timeMs: 1000, label: '' },
      ],
    } as unknown as Project;
    expect(sortedMarkers(project).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('clip kind guards', () => {
  it('distinguishes text and generated clips', () => {
    const media = makeClip();
    const text = makeClip({ text: { content: 'hi', color: '#fff', sizeFrac: 0.08 } });
    const solid = makeClip({ solid: { kind: 'color', color: '#000' } });
    expect(isTextClip(media)).toBe(false);
    expect(isTextClip(text)).toBe(true);
    expect(isGeneratedClip(media)).toBe(false);
    expect(isGeneratedClip(text)).toBe(true);
    expect(isGeneratedClip(solid)).toBe(true);
  });
});
