import { describe, expect, it } from 'vitest';
import { normalizeSpeech, segmentsToCues } from './captions';
import type { CaptionSegment } from './captionsProtocol';
import type { MediaClip } from '../types';

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    kind: 'media',
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 1000,
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  };
}

const seg = (
  startSec: number,
  endSec: number | null,
  text: string,
): CaptionSegment => ({ startSec, endSec, text });

describe('segmentsToCues', () => {
  it('offsets segment times by the clip start on the timeline', () => {
    const cues = segmentsToCues(
      [seg(0, 1, 'hello'), seg(1, 2, 'world')],
      clip(),
    );
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'hello' },
      { startMs: 2000, endMs: 3000, text: 'world' },
    ]);
  });

  it('compresses times by the clip speed', () => {
    // speed 2 → the clip is 2500 ms long on the timeline (source 5000 / 2).
    const cues = segmentsToCues([seg(1, 2, 'x')], clip({ speed: 2 }));
    expect(cues[0]!.startMs).toBe(1000 + 500);
    expect(cues[0]!.endMs).toBe(1000 + 1000);
  });

  it('borrows the next start when a segment has no end', () => {
    const cues = segmentsToCues([seg(0, null, 'a'), seg(1.5, 2, 'b')], clip());
    expect(cues[0]!.endMs).toBe(1000 + 1500);
  });

  it('clamps to the clip end and drops segments beyond it', () => {
    // Clip ends at 1000 + 5000 = 6000 ms.
    const cues = segmentsToCues(
      [seg(4.5, 10, 'tail'), seg(6, 7, 'gone')],
      clip(),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]!.endMs).toBe(6000);
  });
});

/** RMS of a buffer, the quantity the levelling actually targets. */
function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

/** A steady tone at a given amplitude: RMS is amplitude / sqrt(2). */
function tone(amplitude: number, n = 4000): Float32Array {
  return Float32Array.from(
    { length: n },
    (_, i) => Math.sin(i * 0.1) * amplitude,
  );
}

describe('normalizeSpeech', () => {
  it('lifts a quiet take towards the level Whisper expects', () => {
    const quiet = tone(0.02);
    expect(rms(normalizeSpeech(quiet))).toBeCloseTo(0.1, 2);
  });

  it('pulls a hot take back down instead of leaving it hot', () => {
    const loud = tone(0.9);
    expect(rms(normalizeSpeech(loud))).toBeCloseTo(0.1, 2);
  });

  it('never clips, even when the level target asks for more gain', () => {
    // A near-silent voice with one transient: chasing the RMS target blindly
    // would send that transient past full scale.
    const samples = tone(0.001);
    samples[0] = 0.5;
    const peak = Math.max(...normalizeSpeech(samples));
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('caps the boost so silence is not amplified into noise', () => {
    const silent = new Float32Array(1000).fill(1e-6);
    normalizeSpeech(silent);
    // 12x the original, the cap - not the 100000x the RMS target would ask for.
    expect(silent[0]!).toBeCloseTo(1.2e-5, 7);
  });

  it('leaves digital silence exactly as it found it', () => {
    const silence = new Float32Array(100);
    expect([...normalizeSpeech(silence)].every((v) => v === 0)).toBe(true);
  });
});
