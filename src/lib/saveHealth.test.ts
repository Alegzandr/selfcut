import { describe, expect, it } from 'vitest';
import { HEALTHY, nextSaveHealth } from './saveHealth';

describe('nextSaveHealth', () => {
  it('starts healthy and stays healthy on a successful write', () => {
    const s = nextSaveHealth(HEALTHY, 'ok', 1000);
    expect(s.failing).toBe(false);
    expect(s.lastSavedAt).toBe(1000);
    expect(s.justFailed).toBe(false);
  });

  it('announces the first failure of a streak', () => {
    const s = nextSaveHealth(HEALTHY, 'failed', 1000);
    expect(s.failing).toBe(true);
    expect(s.justFailed).toBe(true);
    expect(s.failingSince).toBe(1000);
  });

  it('does not announce the failures that follow it', () => {
    // The old behaviour was one toast per SESSION; the new one is one per
    // streak. Both must stay quiet here, or a save retried every few seconds
    // would bury the editor in toasts.
    let s = nextSaveHealth(HEALTHY, 'failed', 1000);
    s = nextSaveHealth(s, 'failed', 1100);
    s = nextSaveHealth(s, 'failed', 1200);
    expect(s.justFailed).toBe(false);
    expect(s.failures).toBe(3);
    // The clock of the streak is when it STARTED, not the latest failure.
    expect(s.failingSince).toBe(1000);
  });

  it('clears the whole streak on recovery', () => {
    let s = nextSaveHealth(HEALTHY, 'failed', 1000);
    s = nextSaveHealth(s, 'failed', 1100);
    s = nextSaveHealth(s, 'ok', 1200);
    expect(s.failing).toBe(false);
    expect(s.failures).toBe(0);
    expect(s.failingSince).toBe(0);
    expect(s.lastSavedAt).toBe(1200);
  });

  it('announces again after a recovery: a new outage is news', () => {
    // This is precisely what the session-wide latch got wrong. Storage that
    // fills up, is freed, and fills up again must warn twice.
    let s = nextSaveHealth(HEALTHY, 'failed', 1000);
    s = nextSaveHealth(s, 'ok', 2000);
    s = nextSaveHealth(s, 'failed', 3000);
    expect(s.justFailed).toBe(true);
    expect(s.failingSince).toBe(3000);
  });

  it('remembers the last good save through an outage', () => {
    let s = nextSaveHealth(HEALTHY, 'ok', 500);
    s = nextSaveHealth(s, 'failed', 1000);
    s = nextSaveHealth(s, 'failed', 1500);
    expect(s.lastSavedAt).toBe(500);
  });
});
