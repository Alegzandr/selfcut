import { describe, it, expect } from 'vitest';
import {
  clamp,
  formatTime,
  formatTimeShort,
  formatTimecode,
  formatTimecodeParts,
  formatClock,
  parseClock,
} from './time';

describe('formatTime (m:ss.d)', () => {
  it('formats sub-minute times with tenths', () => {
    expect(formatTime(1500)).toBe('0:01.5');
    expect(formatTime(0)).toBe('0:00.0');
  });
  it('rolls over into minutes', () => {
    expect(formatTime(65000)).toBe('1:05.0');
  });
  it('clamps negatives to zero', () => {
    expect(formatTime(-500)).toBe('0:00.0');
  });
});

describe('formatTimeShort (m:ss)', () => {
  it('drops the fractional part', () => {
    expect(formatTimeShort(65000)).toBe('1:05');
    expect(formatTimeShort(1999)).toBe('0:01');
  });
});

describe('formatTimecodeParts', () => {
  it('splits main and frame count at the given fps', () => {
    expect(formatTimecodeParts(1000, 30)).toEqual({ main: '0:01', frames: '00' });
    expect(formatTimecodeParts(1500, 30)).toEqual({ main: '0:01', frames: '15' });
  });
  it('formatTimecode joins them with a colon', () => {
    expect(formatTimecode(1500, 30)).toBe('0:01:15');
  });
});

describe('formatClock', () => {
  it('decimal uses tenths, timecode uses frames', () => {
    expect(formatClock(1500, 30, 'decimal')).toBe('0:01.5');
    expect(formatClock(1500, 30, 'timecode')).toBe('0:01:15');
  });
});

describe('parseClock', () => {
  it('reads a bare number as seconds', () => {
    expect(parseClock('12', 30, 'timecode')).toBe(12000);
    expect(parseClock(' 7 ', 30, 'decimal')).toBe(7000);
  });
  it('reads m:ss', () => {
    expect(parseClock('1:23', 30, 'timecode')).toBe(83000);
  });
  it('reads m:ss:ff as frames in either format', () => {
    expect(parseClock('0:01:15', 30, 'timecode')).toBe(1500);
    expect(parseClock('0:01:15', 30, 'decimal')).toBe(1500);
  });
  it('reads a trailing dot per the display format', () => {
    expect(parseClock('0:01.15', 30, 'timecode')).toBe(1500); // 15 frames
    expect(parseClock('0:01.5', 30, 'decimal')).toBe(1500); // half a second
  });
  it('caps frames at fps-1 so they cannot overflow a second', () => {
    expect(parseClock('0:01.99', 30, 'timecode')).toBeCloseTo(1000 + (29 / 30) * 1000);
  });
  it('round-trips what formatClock renders', () => {
    for (const format of ['timecode', 'decimal'] as const) {
      const ms = format === 'timecode' ? 83500 : 83500;
      expect(parseClock(formatClock(ms, 30, format), 30, format)).toBe(83500);
    }
  });
  it('rejects text that is not a time', () => {
    expect(parseClock('', 30, 'timecode')).toBeNull();
    expect(parseClock('abc', 30, 'timecode')).toBeNull();
    expect(parseClock('1:2:3:4', 30, 'timecode')).toBeNull();
    expect(parseClock('1.5:20', 30, 'timecode')).toBeNull();
    expect(parseClock('-5', 30, 'timecode')).toBeNull();
  });
});

describe('clamp', () => {
  it('bounds a value between min and max', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
