import { describe, expect, it } from 'vitest';
import { SCRATCH_GRACE_MS, scratchToSweep } from './opfs';

describe('scratchToSweep', () => {
  const now = 10 * SCRATCH_GRACE_MS;
  const old = (name: string, ageMs = 2 * SCRATCH_GRACE_MS) => ({ name, lastModified: now - ageMs });

  it('removes old, unlocked files only', () => {
    const entries = [old('a.mp4'), old('b.mp4'), { name: 'young.mp4', lastModified: now - 1000 }];
    expect(scratchToSweep(entries, now, new Set(['b.mp4']))).toEqual(['a.mp4']);
  });

  it('never removes a kept name, however old', () => {
    expect(scratchToSweep([old('mine.mp4')], now, new Set(), { keep: ['mine.mp4'] })).toEqual([]);
  });

  it('spares the most recent other file when a new export starts', () => {
    // The previous export's file may still be downloading: it goes once the new
    // render has finished, not when it starts.
    const entries = [old('older.mp4', 5 * SCRATCH_GRACE_MS), old('last.mp4'), old('new.mp4')];
    expect(
      scratchToSweep(entries, now, new Set(), { keep: ['new.mp4'], keepNewest: true }),
    ).toEqual(['older.mp4']);
  });

  it('reclaims the previous file once the new export is the one kept', () => {
    const entries = [old('last.mp4'), { name: 'new.mp4', lastModified: now }];
    expect(scratchToSweep(entries, now, new Set(), { keep: ['new.mp4'] })).toEqual(['last.mp4']);
  });
});
