import { describe, it, expect } from 'vitest';
import { findExistingAsset } from './importDedup';
import { missingSourceFile } from '../lib/missingSource';
import type { MediaAsset } from '../types';

/**
 * Import deduplication. What is really being protected here is the transcoded
 * audio cache: it is keyed by asset id, so a re-import that mints a new id
 * throws away a conversion that takes minutes to redo.
 */

function asset(id: string, file: File, disconnected = false): MediaAsset {
  return {
    id,
    file,
    kind: 'video',
    durationMs: 1000,
    hasAudio: true,
    audioTracks: [],
    thumbnails: [],
    ...(disconnected ? { disconnected: true } : {}),
  };
}

function fileOf(name: string, size: number, lastModified: number): File {
  // Blob content of the right length: File.size is not writable.
  return new File([new Uint8Array(size)], name, { lastModified });
}

describe('findExistingAsset', () => {
  const source = fileOf('take-1.mkv', 64, 1_700_000_000_000);

  it('matches the same file on name, size and mtime', () => {
    const assets = { a1: asset('a1', source) };
    expect(findExistingAsset(assets, fileOf('take-1.mkv', 64, 1_700_000_000_000))?.id).toBe('a1');
  });

  it('leaves a same-named but different file alone', () => {
    const assets = { a1: asset('a1', source) };
    expect(findExistingAsset(assets, fileOf('take-1.mkv', 99, 1_700_000_000_000))).toBeUndefined();
    expect(findExistingAsset(assets, fileOf('take-1.mkv', 64, 1_700_000_000_001))).toBeUndefined();
    expect(findExistingAsset(assets, fileOf('take-2.mkv', 64, 1_700_000_000_000))).toBeUndefined();
  });

  it('matches a disconnected asset despite its zero-byte stand-in', () => {
    const placeholder = missingSourceFile('take-1.mkv', 1_700_000_000_000);
    const assets = { a1: asset('a1', placeholder, true) };
    expect(findExistingAsset(assets, source)?.id).toBe('a1');
  });

  it('returns nothing for an empty library', () => {
    expect(findExistingAsset({}, source)).toBeUndefined();
  });

  it('matches a remuxed asset against the original file it was made from', () => {
    // The library holds the Matroska we wrote (bigger, and mediabunny-readable);
    // the user re-picks the original AVI. Its own file no longer matches, but the
    // stored source identity does, so the re-import reuses the asset.
    const remuxed = asset('a1', fileOf('take-1.avi', 200, 1_700_000_000_000));
    remuxed.originalSource = { name: 'take-1.avi', size: 64, lastModified: 1_700_000_000_000 };
    const assets = { a1: remuxed };

    expect(findExistingAsset(assets, fileOf('take-1.avi', 64, 1_700_000_000_000))?.id).toBe('a1');
    // A genuinely different source must still miss.
    expect(findExistingAsset(assets, fileOf('take-1.avi', 65, 1_700_000_000_000))).toBeUndefined();
  });
});
