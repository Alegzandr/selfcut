import { describe, expect, it } from 'vitest';
import { firstUncloneable } from './cloneable';

describe('firstUncloneable', () => {
  it('says nothing about a message that clones', () => {
    expect(firstUncloneable({ a: 1, b: [{ c: 'x' }], d: new Float32Array([1, 2]) })).toBeNull();
  });

  it('names the path of the value the browser refuses', () => {
    expect(firstUncloneable({ preset: { fps: 60 }, onDone: () => undefined })).toBe('onDone');
    expect(firstUncloneable({ files: { a3f9: { read: () => undefined } } })).toBe('files.a3f9.read');
  });

  it('indexes into arrays', () => {
    expect(firstUncloneable({ tracks: [{ ok: 1 }, { bad: Symbol('x') }] })).toBe('tracks.1.bad');
  });

  it('reports the first one when several are unclonable', () => {
    expect(firstUncloneable({ a: () => undefined, b: () => undefined })).toBe('a');
  });

  it('blames the container when the value itself is what cannot be cloned', () => {
    // A proxy is refused as a whole; there is no member to point at.
    expect(firstUncloneable({ draft: new Proxy({ x: 1 }, {}) })).toBe('draft');
  });

  it('names the message itself when it is the unclonable value', () => {
    expect(firstUncloneable(() => undefined)).toBe('(the message itself)');
  });
});
