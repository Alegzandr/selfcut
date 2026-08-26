import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isVisualJobActive,
  peaksJobKey,
  resetVisualJobs,
  subscribeVisualJobs,
  thumbnailsJobKey,
  trackVisualJob,
} from './visualJobs';

/**
 * The registry behind "this clip's waveform is on its way".
 *
 * The property that matters is not that it turns ON - anything does that - but
 * that it always turns OFF: a pass that fails, or that finds nothing, must not
 * leave a clip claiming for the rest of the session that something is still
 * happening to it.
 */
afterEach(() => resetVisualJobs());

const KEY = peaksJobKey('a1', 0);

describe('visual job registry', () => {
  it('keys a pass by asset and track, and never confuses two of them', () => {
    // A multi-track video reads one waveform per track: they run, land and are
    // reported independently.
    expect(peaksJobKey('a1', 0)).not.toBe(peaksJobKey('a1', 1));
    expect(peaksJobKey('a1', 0)).not.toBe(peaksJobKey('a2', 0));
    expect(peaksJobKey('a1', 0)).not.toBe(thumbnailsJobKey('a1'));
  });

  it('is active while the pass runs and clear once it lands', async () => {
    let land: (value: string) => void = () => {};
    const work = trackVisualJob(KEY, new Promise<string>((resolve) => (land = resolve)));
    expect(isVisualJobActive(KEY)).toBe(true);

    land('peaks');
    // The value is passed through untouched: callers keep their own handling.
    await expect(work).resolves.toBe('peaks');
    expect(isVisualJobActive(KEY)).toBe(false);
  });

  it('clears when the pass fails, and still rejects', async () => {
    const work = trackVisualJob(KEY, Promise.reject(new Error('unreadable')));
    await expect(work).rejects.toThrow('unreadable');
    expect(isVisualJobActive(KEY)).toBe(false);
  });

  it('clears when the pass finds nothing to read', async () => {
    // A track with no decodable audio resolves to null rather than failing;
    // that is a finished pass, not a running one.
    await trackVisualJob(KEY, Promise.resolve(null));
    expect(isVisualJobActive(KEY)).toBe(false);
  });

  it('survives two callers asking for the same pass', async () => {
    // A project reopened while the first read is still running.
    let landFirst: () => void = () => {};
    const first = trackVisualJob(KEY, new Promise<void>((resolve) => (landFirst = resolve)));
    const second = trackVisualJob(KEY, Promise.resolve());
    await second;
    // The second one finishing says nothing about the first: clearing here
    // would drop the indicator while the real read was still going.
    expect(isVisualJobActive(KEY)).toBe(true);
    landFirst();
    await first;
    expect(isVisualJobActive(KEY)).toBe(false);
  });

  it('notifies subscribers on both edges, and stops after unsubscribing', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVisualJobs(listener);
    await trackVisualJob(KEY, Promise.resolve());
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await trackVisualJob(KEY, Promise.resolve());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reports nothing running when nothing is', () => {
    expect(isVisualJobActive(KEY)).toBe(false);
    expect(isVisualJobActive(thumbnailsJobKey('nobody'))).toBe(false);
  });
});
