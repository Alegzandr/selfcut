import { describe, expect, it } from 'vitest';
import { nextSaveDelay } from './saveSchedule';

const DEBOUNCE = 500;
const MAX_WAIT = 2000;

describe('nextSaveDelay', () => {
  it('debounces a quiet editor normally', () => {
    // First change of a burst: nothing is overdue, so the full debounce applies.
    expect(nextSaveDelay(1000, 1000, DEBOUNCE, MAX_WAIT)).toBe(DEBOUNCE);
  });

  it('keeps debouncing while the burst is young', () => {
    // 300 ms into a burst: still far from the ceiling.
    expect(nextSaveDelay(1300, 1000, DEBOUNCE, MAX_WAIT)).toBe(DEBOUNCE);
  });

  it('shortens the wait as the ceiling approaches', () => {
    // 1.7 s into an unbroken edit stream: only 300 ms of grace left.
    expect(nextSaveDelay(2700, 1000, DEBOUNCE, MAX_WAIT)).toBe(300);
  });

  it('writes immediately once the ceiling is reached', () => {
    // This is the case a plain debounce never reaches: a drag or a batch import
    // updates the store faster than the debounce window, so the timer kept
    // being pushed forward and the timeline stayed unwritten indefinitely.
    expect(nextSaveDelay(3000, 1000, DEBOUNCE, MAX_WAIT)).toBe(0);
    expect(nextSaveDelay(60_000, 1000, DEBOUNCE, MAX_WAIT)).toBe(0);
  });

  it('bounds an unbroken edit stream to the ceiling', () => {
    // Simulate a 10 s drag firing an update every 16 ms, the way a pointermove
    // stream does, and check the writes actually happen.
    const start = 0;
    let oldestPendingAt = start;
    let due = start + nextSaveDelay(start, oldestPendingAt, DEBOUNCE, MAX_WAIT);
    const writes: number[] = [];
    for (let now = start; now <= 10_000; now += 16) {
      if (now >= due) {
        writes.push(now);
        // A write clears the pending window; the next change starts a new one.
        oldestPendingAt = now;
      }
      due = now + nextSaveDelay(now, oldestPendingAt, DEBOUNCE, MAX_WAIT);
    }
    expect(writes.length).toBeGreaterThanOrEqual(5);
    // No gap longer than the ceiling (plus one tick of scheduling slack).
    const gaps = writes.slice(1).map((w, i) => w - writes[i]!);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(MAX_WAIT + 16);
  });
});
