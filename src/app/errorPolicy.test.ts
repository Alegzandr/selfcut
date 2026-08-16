import { describe, expect, it } from 'vitest';
import { classifyError, errorSignature } from './errorPolicy';

describe('classifyError', () => {
  it('tells the user to reload when a chunk no longer exists', () => {
    // The classic post-deploy failure: the tab holds an index that points at
    // hashes the server has replaced. It reads as a crash and is cured by a
    // reload, so it deserves its own message.
    for (const m of [
      'Failed to fetch dynamically imported module: https://x/assets/a.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'ChunkLoadError: Loading chunk 42 failed',
    ]) {
      expect(classifyError(m)).toBe('reload');
    }
  });

  it('stays silent on opaque cross-origin errors', () => {
    // "Script error." is what a browser extension's throw looks like from
    // here: no file, no line, no stack, nothing the user can act on.
    expect(classifyError('Script error.')).toBe('log');
    expect(classifyError('script error')).toBe('log');
    expect(classifyError('  Script error.  ')).toBe('log');
    expect(classifyError('')).toBe('log');
  });

  it('notifies for anything else', () => {
    expect(classifyError('Cannot read properties of null')).toBe('notify');
    expect(classifyError('QuotaExceededError')).toBe('notify');
  });

  it('does not mistake an ordinary error mentioning a module for a stale build', () => {
    expect(classifyError('module is not defined')).toBe('notify');
  });
});

describe('errorSignature', () => {
  it('collapses repeats of the same failure onto one key', () => {
    expect(errorSignature('decode failed')).toBe(errorSignature('decode failed'));
  });

  it('keeps distinct failures distinct', () => {
    expect(errorSignature('decode failed')).not.toBe(errorSignature('encode failed'));
  });

  it('bounds the key so a giant message cannot be retained in full', () => {
    expect(errorSignature('x'.repeat(5000)).length).toBe(200);
  });
});
