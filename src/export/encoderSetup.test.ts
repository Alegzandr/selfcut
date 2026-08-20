import { describe, expect, it, vi } from 'vitest';
import { chooseEncoderSetup, type ProbeResult } from './encoderSetup';

/**
 * A scripted encoder: answers whatever the table says for
 * `${acceleration}/${cadence ? 'cadence' : 'plain'}`, and records the order it
 * was asked in. `ok` is the default, so a case only has to state the answers
 * that are not.
 */
function encoder(answers: Record<string, ProbeResult>) {
  const asked: string[] = [];
  const probe = vi.fn(async (declareFrameRate: boolean, acceleration: string) => {
    const key = `${acceleration}/${declareFrameRate ? 'cadence' : 'plain'}`;
    asked.push(key);
    return answers[key] ?? 'ok';
  });
  return { probe: probe as Parameters<typeof chooseEncoderSetup>[0], asked };
}

describe('chooseEncoderSetup', () => {
  it('keeps the browser’s own encoder and the cadence when both work', async () => {
    const { probe, asked } = encoder({});
    await expect(chooseEncoderSetup(probe, false)).resolves.toEqual({
      declareFrameRate: true,
      hardwareAcceleration: 'no-preference',
    });
    // One probe, and no software encoder ever built: the common case has to
    // stay a single frame of work.
    expect(asked).toEqual(['no-preference/cadence']);
  });

  it('gives up the cadence, not the encoder, when the cadence is refused', async () => {
    const { probe, asked } = encoder({ 'no-preference/cadence': 'refused' });
    await expect(chooseEncoderSetup(probe, false)).resolves.toEqual({
      declareFrameRate: false,
      hardwareAcceleration: 'no-preference',
    });
    // A refusal is an answer. Moving a working export onto the software encoder
    // over it would trade a fast render for a slow one to no purpose.
    expect(asked).toEqual(['no-preference/cadence', 'no-preference/plain']);
  });

  it('falls back to the software encoder when the browser’s pick stalls', async () => {
    const { probe, asked } = encoder({ 'no-preference/cadence': 'stalled' });
    await expect(chooseEncoderSetup(probe, false)).resolves.toEqual({
      declareFrameRate: true,
      hardwareAcceleration: 'prefer-software',
    });
    // No second question asked of an encoder that has stopped answering: the
    // cadence is not what is wrong with it.
    expect(asked).toEqual(['no-preference/cadence', 'prefer-software/cadence']);
  });

  it('falls back when the stall only shows up without the cadence', async () => {
    const { probe } = encoder({
      'no-preference/cadence': 'refused',
      'no-preference/plain': 'stalled',
    });
    await expect(chooseEncoderSetup(probe, false)).resolves.toEqual({
      declareFrameRate: true,
      hardwareAcceleration: 'prefer-software',
    });
  });

  it('still returns a setup when even the software encoder produces nothing', async () => {
    const { probe } = encoder({
      'no-preference/cadence': 'stalled',
      'no-preference/plain': 'stalled',
      'prefer-software/cadence': 'stalled',
      'prefer-software/plain': 'stalled',
    });
    // The render is probably doomed, but it is the watchdogs in the loop that
    // end it - with something to report - rather than a refusal to start.
    await expect(chooseEncoderSetup(probe, false)).resolves.toEqual({
      declareFrameRate: false,
      hardwareAcceleration: 'prefer-software',
    });
  });

  it('never re-tries the encoder that already stalled once', async () => {
    const { probe, asked } = encoder({});
    await expect(chooseEncoderSetup(probe, true)).resolves.toEqual({
      declareFrameRate: true,
      hardwareAcceleration: 'prefer-software',
    });
    // The retry after an `encoderStalled` export must not spend its first
    // fifteen seconds proving the same encoder is still stalled.
    expect(asked).toEqual(['prefer-software/cadence']);
  });

  it('reports every encoder it abandoned', async () => {
    const { probe } = encoder({
      'no-preference/cadence': 'stalled',
      'prefer-software/cadence': 'stalled',
      'prefer-software/plain': 'stalled',
    });
    const onStall = vi.fn();
    await chooseEncoderSetup(probe, false, onStall);
    expect(onStall.mock.calls.flat()).toEqual(['no-preference', 'prefer-software']);
  });
});
