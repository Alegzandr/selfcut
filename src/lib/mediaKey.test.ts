import { describe, expect, it } from 'vitest';
import { mediaKeyOf } from './mediaKey';
import { missingSourceFile } from './missingSource';

function file(name: string, size: number, lastModified: number): File {
  return new File([new Uint8Array(size)], name, { lastModified });
}

describe('mediaKeyOf', () => {
  // The whole point: the key survives the asset it was first minted for, so a
  // file removed from the library and imported again lands on its own cache.
  it('gives the same key to two File objects over the same file', () => {
    expect(mediaKeyOf(file('rip.mkv', 12, 1700))).toBe(mediaKeyOf(file('rip.mkv', 12, 1700)));
  });

  it('separates files that differ in name, size or mtime', () => {
    const base = mediaKeyOf(file('rip.mkv', 12, 1700));
    expect(mediaKeyOf(file('other.mkv', 12, 1700))).not.toBe(base);
    expect(mediaKeyOf(file('rip.mkv', 13, 1700))).not.toBe(base);
    expect(mediaKeyOf(file('rip.mkv', 12, 1701))).not.toBe(base);
  });

  // Keys are `${mediaKey}#${trackIndex}`, so a '#' in the name would otherwise
  // be indistinguishable from the separator and collide across track indexes.
  it('escapes a name that contains the key separator', () => {
    expect(mediaKeyOf(file('a#1.mkv', 12, 1700))).not.toContain('#');
    expect(mediaKeyOf(file('a#1.mkv', 12, 1700))).not.toBe(mediaKeyOf(file('a#2.mkv', 12, 1700)));
  });

  // A placeholder is a zero-byte stand-in, so every unrelinked asset of a given
  // name would key to one entry that belongs to none of them.
  it('refuses to key an asset waiting to be relinked', () => {
    expect(mediaKeyOf(missingSourceFile('rip.mkv', 1700))).toBeNull();
  });
});
