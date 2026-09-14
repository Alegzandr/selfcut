import { describe, expect, it } from 'vitest';
import { MasterChain } from './masterChain';
import { MASTER_TARGET_LUFS } from '../lib/loudness';

/**
 * The chain is checked end to end on a synthetic mix: a stereo sine the meter
 * reads at a known level, served through `render` in pieces the way the
 * encoder pulls them. What matters is that the pieces, joined, are the raw
 * mix times the gain the measurement decided - whatever the piece size, and
 * whether or not the encoder started over.
 */

const SR = 48_000;
const SLICE = SR;

/** A stereo 1 kHz sine at `db` dBFS, `frames` long, as a raw renderer over it. */
function sineMix(db: number, frames: number) {
  const amp = 10 ** (db / 20);
  const signal = new Float32Array(frames + SR);
  for (let i = 0; i < signal.length; i++) {
    signal[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  const calls: [number, number][] = [];
  const raw = async (offset: number, count: number) => {
    calls.push([offset, count]);
    // Like the offline context: whatever the timeline holds there, silence
    // past the end of the source.
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = signal[offset + i] ?? 0;
    return [out, out.slice()];
  };
  return { signal, raw, calls };
}

async function serve(chain: MasterChain, total: number, piece: number): Promise<Float32Array> {
  const out = new Float32Array(total);
  for (let at = 0; at < total; at += piece) {
    const frames = Math.min(piece, total - at);
    const [l] = await chain.render(at, frames);
    out.set(l!, at);
  }
  return out;
}

describe('MasterChain', () => {
  it('measures the mix and serves it at the master target', async () => {
    const total = 5 * SR;
    const { signal, raw } = sineMix(-24, total);
    const chain = new MasterChain(raw, SR, 2, total, SLICE);
    const decision = (await chain.measure())!;
    expect(decision.measuredLufs).toBeCloseTo(-24, 1);
    expect(decision.gainDb).toBeCloseTo(MASTER_TARGET_LUFS + 24, 0);
    expect(decision.limited).toBe(false);

    const out = await serve(chain, total, SLICE);
    const gain = 10 ** (decision.gainDb / 20);
    for (let i = 0; i < total; i += 997) expect(out[i]).toBeCloseTo(signal[i]! * gain, 5);
  });

  it('joins the pieces seamlessly whatever their size', async () => {
    const total = 3 * SR + 123;
    const { raw } = sineMix(-24, total);
    const whole = await serve(new MasterChain(raw, SR, 2, total, SLICE), total, total);
    const pieces = await serve(new MasterChain(raw, SR, 2, total, SLICE), total, 7000);
    expect(pieces).toEqual(whole);
  });

  it('starts the stream over when the encoder does', async () => {
    const total = 2 * SR;
    const { raw } = sineMix(-24, total);
    const chain = new MasterChain(raw, SR, 2, total, SLICE);
    const first = await serve(chain, total, SLICE);
    // A retried render pulls from frame 0 again on the same chain.
    const again = await serve(chain, total, SLICE);
    expect(again).toEqual(first);
  });

  it('never lets what follows the export steer the limiter', async () => {
    const total = SR;
    const { raw, signal } = sineMix(-24, total);
    // A full-scale burst right after the export's end.
    for (let i = total; i < total + 100; i++) signal[i] = 1;
    const chain = new MasterChain(raw, SR, 2, total, SLICE);
    const out = await serve(chain, total, SLICE);
    const gain = 10 ** ((await chain.measure())!.gainDb / 20);
    // The last frame is still the sine times the gain, not ducked for a peak
    // the file does not contain.
    expect(out[total - 1]).toBeCloseTo(signal[total - 1]! * gain, 5);
  });

  it('serves the raw mix when there is nothing to measure', async () => {
    const total = SR;
    const raw = async (_o: number, n: number) => [new Float32Array(n), new Float32Array(n)];
    const chain = new MasterChain(raw, SR, 2, total, SLICE);
    expect(await chain.measure()).toBeNull();
    const [l] = await chain.render(0, 100);
    expect(l).toHaveLength(100);
  });
});
