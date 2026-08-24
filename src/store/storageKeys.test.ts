import { describe, expect, it } from 'vitest';
import { selfcutStorageKeys } from '../store/constants';

/**
 * The erase is destructive and unattended, so the rule that decides what it
 * touches is the one part worth pinning down: too narrow and a "cleared" app
 * still remembers the last project, too wide and it deletes a neighbour's keys
 * on an origin it does not own alone.
 */
describe('selfcutStorageKeys', () => {
  it('takes every key the app writes', () => {
    expect(
      selfcutStorageKeys([
        'selfcut.timeFormat',
        'selfcut.currentProjectId',
        'selfcut.captions.model',
        'selfcut.lang',
      ]),
    ).toEqual([
      'selfcut.timeFormat',
      'selfcut.currentProjectId',
      'selfcut.captions.model',
      'selfcut.lang',
    ]);
  });

  it('leaves other keys on the origin alone', () => {
    // Including the near-misses: a key that merely mentions the app, and one
    // whose name starts the same way without the dot that makes it ours.
    expect(
      selfcutStorageKeys(['theme', 'selfcutter.session', 'x-selfcut.token', '']),
    ).toEqual([]);
  });
});
