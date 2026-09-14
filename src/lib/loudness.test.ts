import { describe, expect, it } from 'vitest';
import { LoudnessMeter, PEAK_CEILING_DB, TARGET_LUFS, balanceGain } from './loudness';
import { MAX_GAIN, gainToDb } from './gain';

/**
 * The meter is checked against the signals the standard's own compliance
 * material uses: a 1 kHz sine at a known dBFS level, in stereo, reads as that
 * level in LUFS (EBU Tech 3341, test case 1), and the gates drop silence and
 * pauses without moving the reading of what surrounds them.
 */

/** A stereo 1 kHz sine at `db` dBFS per channel, `seconds` long. */
function sine(db: number, seconds: number, sampleRate = 48000, freq = 1000): Float32Array[] {
  const amp = 10 ** (db / 20);
  const n = Math.round(seconds * sampleRate);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return [l, l.slice()];
}

function silence(seconds: number, sampleRate = 48000): Float32Array[] {
  const n = Math.round(seconds * sampleRate);
  return [new Float32Array(n), new Float32Array(n)];
}

function measure(pieces: Float32Array[][], sampleRate = 48000) {
  const meter = new LoudnessMeter(sampleRate, 2);
  for (const piece of pieces) meter.process(piece);
  return meter.result();
}

describe('LoudnessMeter', () => {
  it('reads a stereo -20 dBFS 1 kHz sine as -20 LUFS', () => {
    const { lufs, peak } = measure([sine(-20, 5)]);
    expect(lufs).toBeCloseTo(-20, 1);
    expect(peak).toBeCloseTo(0.1, 3);
  });

  it('reads -23 dBFS as -23 LUFS (EBU Tech 3341 case 1)', () => {
    expect(measure([sine(-23, 20)]).lufs).toBeCloseTo(-23, 1);
  });

  it('gives the same reading at 44.1 and 96 kHz', () => {
    // The K-weighting is re-derived per rate: the 48 kHz table run at another
    // rate would shift both filter corners by the same ratio.
    expect(measure([sine(-20, 5, 44100)], 44100).lufs).toBeCloseTo(-20, 1);
    expect(measure([sine(-20, 5, 96000)], 96000).lufs).toBeCloseTo(-20, 1);
  });

  it('is silence-gated: trailing silence does not lower the reading', () => {
    // Within 0.2 LU rather than exact: the blocks straddling the cut hold
    // part sine, part silence, and pass the gate at a slightly lower level -
    // which is what a real meter reads there too.
    expect(Math.abs(measure([sine(-20, 5), silence(10)]).lufs + 20)).toBeLessThan(0.2);
  });

  it('is pause-gated: a passage 20 dB under the programme is dropped', () => {
    // Ungated mean of -20 and -40 is about -23; the relative gate sits 10 LU
    // below that, so the -40 half falls out and the reading stays at -20.
    expect(Math.abs(measure([sine(-20, 10), sine(-40, 10)]).lufs + 20)).toBeLessThan(0.2);
  });

  it('keeps a passage only 6 dB under: that is dynamics, not a pause', () => {
    const { lufs } = measure([sine(-20, 10), sine(-26, 10)]);
    expect(lufs).toBeLessThan(-21);
    expect(lufs).toBeGreaterThan(-24);
  });

  it('reads silence as -Infinity with a zero peak', () => {
    expect(measure([silence(3)])).toEqual({ lufs: -Infinity, peak: 0 });
  });

  it('reads a clip shorter than one gating block from what there is', () => {
    expect(measure([sine(-20, 0.25)]).lufs).toBeCloseTo(-20, 0);
  });

  it('is streaming: odd-sized pieces read the same as one block', () => {
    const [l, r] = sine(-18, 7);
    const whole = measure([[l!, r!]]).lufs;
    const pieces: Float32Array[][] = [];
    // Piece lengths that never align with the 100 ms sub-block grid.
    for (let at = 0, k = 1; at < l!.length; k++) {
      const len = 4801 * k;
      pieces.push([l!.subarray(at, at + len), r!.subarray(at, at + len)]);
      at += len;
    }
    expect(pieces.length).toBeGreaterThan(3);
    expect(measure(pieces).lufs).toBeCloseTo(whole, 3);
  });

  it('reads a mono channel 3 dB under the same sine in stereo', () => {
    const [l] = sine(-20, 5);
    const mono = new LoudnessMeter(48000, 1);
    mono.process([l!]);
    expect(mono.result().lufs).toBeCloseTo(-23, 1);
  });

  it('refuses a format it cannot meter', () => {
    expect(() => new LoudnessMeter(0, 2)).toThrow(RangeError);
    expect(() => new LoudnessMeter(48000, 0)).toThrow(RangeError);
  });
});

describe('balanceGain', () => {
  it('lifts a quiet clip to the target', () => {
    const d = balanceGain({ lufs: -26, peak: 0.1 })!;
    expect(gainToDb(d.gain)).toBeCloseTo(TARGET_LUFS + 26, 5);
    expect(d.limited).toBe(false);
  });

  it('turns a loud clip down to the target', () => {
    const d = balanceGain({ lufs: -8, peak: 0.9 })!;
    expect(gainToDb(d.gain)).toBeCloseTo(TARGET_LUFS + 8, 5);
    expect(d.limited).toBe(false);
  });

  it('holds the lift back where the peak would cross the ceiling', () => {
    // Wants +10 dB but the peak is already at -3 dBFS: only 2 dB of room.
    const peak = 10 ** (-3 / 20);
    const d = balanceGain({ lufs: -26, peak })!;
    expect(gainToDb(d.gain)).toBeCloseTo(PEAK_CEILING_DB + 3, 1);
    expect(d.limited).toBe(true);
  });

  it('never exceeds the fader range, and says the target was missed', () => {
    const d = balanceGain({ lufs: -60, peak: 0.0001 })!;
    expect(d.gain).toBe(MAX_GAIN);
    expect(d.limited).toBe(true);
  });

  it('quantizes to the 0.1 dB the faders store', () => {
    const d = balanceGain({ lufs: -23.456, peak: 0.1 })!;
    expect(Math.round(gainToDb(d.gain) * 10) / 10).toBeCloseTo(gainToDb(d.gain), 6);
  });

  it('leaves silence alone', () => {
    expect(balanceGain({ lufs: -Infinity, peak: 0 })).toBeNull();
  });
});
