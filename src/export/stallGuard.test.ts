import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StalledError, withDeadline } from './stallGuard';

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes the value through when the promise wins', async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, 'thing')).resolves.toBe(7);
  });

  it('passes a rejection through unchanged', async () => {
    const boom = new Error('boom');
    await expect(withDeadline(Promise.reject(boom), 1000, 'thing')).rejects.toBe(boom);
  });

  it('rejects with a StalledError naming what stopped', async () => {
    // The promise that never settles is the whole point: this is what an
    // encoder that took a configuration it cannot deliver looks like from here.
    const pending = withDeadline(new Promise<void>(() => {}), 30_000, 'video encoder');
    const settled = expect(pending).rejects.toThrow(StalledError);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    await expect(pending).rejects.toThrow(/video encoder stopped responding after 30s/);
  });

  it('clears the timer when the promise wins', async () => {
    // Over the thousands of frames of a render, a timer left per await is
    // thousands of live timers.
    await withDeadline(Promise.resolve('done'), 60_000, 'thing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not surface a late rejection as an unhandled one', async () => {
    let reject: (e: Error) => void = () => {};
    const late = new Promise<void>((_, r) => {
      reject = r;
    });
    const guarded = withDeadline(late, 1000, 'thing');
    // Attached before the timer fires: a rejection nobody is listening to yet
    // is an unhandled one, which is the very thing this test is watching for.
    const settled = expect(guarded).rejects.toThrow(StalledError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    // The loser rejecting afterwards must stay contained: `race` has already
    // attached a handler, so nothing here should reach the unhandled path.
    reject(new Error('too late'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
