import { describe, expect, it } from 'vitest';
import { outputLatencyS } from './audioMix';

/**
 * The picture is timed off the audio clock minus the time the sound takes to
 * reach the speakers. What the browser reports for that varies by engine and
 * device, and a bad reading must never push the playhead anywhere strange.
 */
describe('outputLatencyS', () => {
  it('prefers outputLatency (the device leg, hundreds of ms on Bluetooth)', () => {
    expect(outputLatencyS({ outputLatency: 0.25, baseLatency: 0.01 })).toBe(0.25);
  });

  it('falls back to baseLatency where outputLatency is missing or not yet known', () => {
    expect(outputLatencyS({ baseLatency: 0.01 } as AudioContext)).toBe(0.01);
    expect(outputLatencyS({ outputLatency: 0, baseLatency: 0.01 })).toBe(0.01);
  });

  it('reads nonsense as no latency', () => {
    expect(outputLatencyS({} as AudioContext)).toBe(0);
    expect(outputLatencyS({ outputLatency: NaN, baseLatency: NaN })).toBe(0);
    expect(outputLatencyS({ outputLatency: -1, baseLatency: 0 })).toBe(0);
    expect(outputLatencyS({ outputLatency: Infinity, baseLatency: 0 })).toBe(0);
  });
});
