import { describe, expect, it } from 'vitest';
import { folderFileName, isFolderFileRef } from './storageFolder';

/**
 * The naming rule decides what the user sees in their own folder and whether
 * two assets can ever overwrite each other's copy, and the record check
 * decides whether a restore trusts what it finds in FILES_STORE. Both are pure.
 */
describe('folderFileName', () => {
  it('keeps the original name readable and the extension in place', () => {
    expect(folderFileName('interview.mp4', 'asset_3f2a1b2c')).toBe(
      'interview [asset_3f2a1b2c].mp4',
    );
  });

  // Two projects can each import an `interview.mp4`: the tag is what keeps
  // their copies apart, so it has to differ per asset and repeat per asset.
  // Real ids share their first characters (`asset_`), which is exactly what a
  // truncated tag would have collapsed onto.
  it('is unique per asset and stable for one', () => {
    const a = folderFileName('interview.mp4', 'asset_aaaaaaaa');
    const b = folderFileName('interview.mp4', 'asset_bbbbbbbb');
    expect(a).not.toBe(b);
    expect(folderFileName('interview.mp4', 'asset_aaaaaaaa')).toBe(a);
  });

  it('keeps only file-name-safe characters of the id', () => {
    expect(folderFileName('a.mp4', 'we/ird:id')).toBe('a [weirdid].mp4');
  });

  it('treats a leading dot as part of the name, not as an extension', () => {
    expect(folderFileName('.hidden', 'abcdef01')).toBe('.hidden [abcdef01]');
    expect(folderFileName('noext', 'abcdef01')).toBe('noext [abcdef01]');
  });

  // The original name can come from another OS or a browser drag; the folder
  // may well be on Windows.
  it('replaces characters a file system may refuse', () => {
    expect(folderFileName('take 2: "final"?.mov', 'abcdef01')).toBe(
      'take 2_ _final__ [abcdef01].mov',
    );
    expect(folderFileName('a/b\\c.mp4', 'abcdef01')).toBe('a_b_c [abcdef01].mp4');
  });

  it('never produces an empty stem', () => {
    expect(folderFileName('', 'abcdef01')).toBe('media [abcdef01]');
    expect(folderFileName('interview.mp4', '')).toBe('interview [asset].mp4');
  });
});

describe('isFolderFileRef', () => {
  const ref = {
    folder: true,
    path: 'interview [3f2a1b2c].mp4',
    name: 'interview.mp4',
    type: 'video/mp4',
    lastModified: 1700,
    size: 12,
  };

  it('accepts a complete record', () => {
    expect(isFolderFileRef(ref)).toBe(true);
  });

  it('rejects anything else the store can hold', () => {
    expect(isFolderFileRef(new File([], 'interview.mp4'))).toBe(false);
    expect(isFolderFileRef(null)).toBe(false);
    expect(isFolderFileRef(undefined)).toBe(false);
    expect(isFolderFileRef('interview [3f2a1b2c].mp4')).toBe(false);
  });

  // A record missing any of the four identity fields could not restore a File
  // with the identity the caches and the relink match on.
  it('rejects a record with a field missing', () => {
    for (const key of Object.keys(ref)) {
      const { [key as keyof typeof ref]: _dropped, ...partial } = ref;
      expect(isFolderFileRef(partial)).toBe(false);
    }
  });
});
