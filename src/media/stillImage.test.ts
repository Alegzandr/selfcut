import { describe, it, expect } from 'vitest';
import { isImageFile } from './stillImage';

describe('isImageFile', () => {
  it('matches by MIME type whatever the name', () => {
    expect(isImageFile(new File([], 'photo', { type: 'image/jpeg' }))).toBe(true);
    expect(isImageFile(new File([], 'clip.bin', { type: 'image/webp' }))).toBe(true);
  });

  it('matches by extension when the MIME type is missing', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'f.avif', 'g.bmp', 'h.svg']) {
      expect(isImageFile(new File([], name))).toBe(true);
    }
  });

  it('rejects video, audio and subtitle files', () => {
    expect(isImageFile(new File([], 'a.mp4', { type: 'video/mp4' }))).toBe(false);
    expect(isImageFile(new File([], 'b.mp3', { type: 'audio/mpeg' }))).toBe(false);
    expect(isImageFile(new File([], 'c.srt'))).toBe(false);
  });
});
