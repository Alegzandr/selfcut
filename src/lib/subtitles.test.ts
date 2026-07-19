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
    expect(parseSubtitles(vtt)).toEqual([
      { startMs: 1000, endMs: 2000, text: 'Hi there', align: 'left', vAlign: 'top' },
    ]);
  });

  it('strips inline markup and joins multi-line cues, keeping the placement tag', () => {
    const srt = ['00:00:00,000 --> 00:00:01,000', '<i>Hello</i>', '{\\an8}World'].join('\n');
    expect(parseSubtitles(srt)).toEqual([
      { startMs: 0, endMs: 1000, text: 'Hello\nWorld', align: 'center', vAlign: 'top' },
    ]);
  });

  it('leaves placement undefined when the file states none', () => {
    const cue = parseSubtitles('00:00:00,000 --> 00:00:01,000\nPlain')[0]!;
    expect(cue.align).toBeUndefined();
    expect(cue.vAlign).toBeUndefined();
  });

  it('maps the \\an numpad layout to a band and an alignment', () => {
    const at = (tag: string) =>
      parseSubtitles(`00:00:00,000 --> 00:00:01,000\n${tag}Text`)[0]!;
    expect(at('{\\an1}')).toMatchObject({ align: 'left', vAlign: 'bottom' });
    expect(at('{\\an5}')).toMatchObject({ align: 'center', vAlign: 'middle' });
    expect(at('{\\an9}')).toMatchObject({ align: 'right', vAlign: 'top' });
  });

  it('maps legacy SSA \\a tags, which order the bands differently', () => {
    const cue = parseSubtitles('00:00:00,000 --> 00:00:01,000\n{\\a6}Top center')[0]!;
    expect(cue).toMatchObject({ align: 'center', vAlign: 'top' });
  });

  it('reads a WebVTT percentage line as a band', () => {
    const band = (line: string) =>
      parseSubtitles(`WEBVTT\n\n00:01.000 --> 00:02.000 ${line}\nText`)[0]!.vAlign;
    expect(band('line:10%')).toBe('top');
    expect(band('line:50%')).toBe('middle');
    expect(band('line:90%')).toBe('bottom');
    // A bare index counts up from the bottom when negative.
    expect(band('line:-1')).toBe('bottom');
  });

  it('lets an inline tag win over a cue setting', () => {
    const vtt = ['WEBVTT', '', '00:01.000 --> 00:02.000 align:start', '{\\an3}Right'].join('\n');
    expect(parseSubtitles(vtt)[0]).toMatchObject({ align: 'right', vAlign: 'bottom' });
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

describe('parseSubtitles - SubStation Alpha', () => {
  it('matches .ass and .ssa file names', () => {
    expect(isSubtitleFile(new File([], 'a.ass'))).toBe(true);
    expect(isSubtitleFile(new File([], 'b.SSA'))).toBe(true);
  });

  it('parses Dialogue events with the standard v4+ format', () => {
    const ass = [
      '[Script Info]',
      'Title: test',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,Hello world',
    ].join('\n');
    expect(parseSubtitles(ass)).toEqual([{ startMs: 1500, endMs: 3000, text: 'Hello world' }]);
  });

  it('strips override tags, honors \\N line breaks and keeps commas in the text', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\b1}One, two{\\b0}\\Nthree',
    ].join('\n');
    expect(parseSubtitles(ass)).toEqual([{ startMs: 0, endMs: 2000, text: 'One, two\nthree' }]);
  });

  it('follows a custom Format field order', () => {
    const ass = [
      '[Events]',
      'Format: Start, End, Text',
      'Dialogue: 0:00:01.00,0:00:02.00,Short form',
    ].join('\n');
    expect(parseSubtitles(ass)).toEqual([{ startMs: 1000, endMs: 2000, text: 'Short form' }]);
  });

  it('skips malformed Dialogue lines and sorts by start time', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,not-a-time,0:00:03.00,Default,,0,0,0,,Broken',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Later',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Earlier',
    ].join('\n');
    expect(parseSubtitles(ass).map((c) => c.text)).toEqual(['Earlier', 'Later']);
  });
});
