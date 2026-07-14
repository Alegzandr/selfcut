import { describe, it, expect } from 'vitest';
import { parseSubtitles, isSubtitleFile } from './subtitles';

describe('isSubtitleFile', () => {
  it('matches .srt and .vtt case-insensitively', () => {
    expect(isSubtitleFile(new File([], 'a.srt'))).toBe(true);
    expect(isSubtitleFile(new File([], 'b.VTT'))).toBe(true);
    expect(isSubtitleFile(new File([], 'c.mp4'))).toBe(false);
  });
});

describe('parseSubtitles', () => {
  it('parses a basic SRT with counters', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,500', 'Hello', '', '2', '00:00:03,000 --> 00:00:04,000', 'World'].join('\n');
    expect(parseSubtitles(srt)).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Hello' },
      { startMs: 3000, endMs: 4000, text: 'World' },
    ]);
  });

  it('parses WebVTT with a header and cue settings after the end time', () => {
    const vtt = ['WEBVTT', '', '00:01.000 --> 00:02.000 line:0 align:start', 'Hi there'].join('\n');
    expect(parseSubtitles(vtt)).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hi there' }]);
  });

  it('strips inline markup and joins multi-line cues', () => {
    const srt = ['00:00:00,000 --> 00:00:01,000', '<i>Hello</i>', '{\\an8}World'].join('\n');
    expect(parseSubtitles(srt)).toEqual([{ startMs: 0, endMs: 1000, text: 'Hello\nWorld' }]);
  });

  it('skips blocks with no timing, no text, or non-positive duration', () => {
    const srt = [
      'NOTE this is a comment',
      '',
      '00:00:02,000 --> 00:00:02,000',
      'zero duration',
      '',
      '00:00:05,000 --> 00:00:06,000',
      'kept',
    ].join('\n');
    expect(parseSubtitles(srt)).toEqual([{ startMs: 5000, endMs: 6000, text: 'kept' }]);
  });

  it('sorts cues by start time', () => {
    const srt = ['00:00:05,000 --> 00:00:06,000', 'later', '', '00:00:01,000 --> 00:00:02,000', 'earlier'].join('\n');
    expect(parseSubtitles(srt).map((c) => c.text)).toEqual(['earlier', 'later']);
  });

  it('tolerates CRLF line endings and a BOM', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n';
    expect(parseSubtitles(srt)).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hi' }]);
  });
});
