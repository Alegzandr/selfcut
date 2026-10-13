import { describe, it, expect } from 'vitest';
import { decodeSubtitleBytes, formatSubtitles, parseSubtitles, isSubtitleFile } from './subtitles';

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


/**
 * Writing back out. The exporter's job is that a track imported, edited and
 * re-exported still says the same thing, so the round trip through the parser
 * is the real test - the literal-shape assertions only pin what players see.
 */
describe('formatSubtitles', () => {
  const cues = [
    { startMs: 0, endMs: 1500, text: 'First line' },
    { startMs: 3_601_050, endMs: 3_602_000, text: 'Two\nlines' },
  ];

  it('writes SRT with a 1-based counter and comma timestamps', () => {
    expect(formatSubtitles(cues, 'srt')).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:01,500',
        'First line',
        '',
        '2',
        '01:00:01,050 --> 01:00:02,000',
        'Two',
        'lines',
        '',
      ].join('\n'),
    );
  });

  it('writes WebVTT with its header and dot timestamps', () => {
    const vtt = formatSubtitles(cues, 'vtt');
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.500');
    // No cue counter: VTT numbers nothing, and a stray digit line would read
    // as a cue identifier.
    expect(vtt).not.toContain('\n1\n');
  });

  it('states a placement only when it differs from the caption default', () => {
    const placed = [
      { startMs: 0, endMs: 1000, text: 'Top left', align: 'left' as const, vAlign: 'top' as const },
      { startMs: 1000, endMs: 2000, text: 'Plain' },
    ];
    const srt = formatSubtitles(placed, 'srt');
    expect(srt).toContain('{\\an7}Top left');
    expect(srt).toContain('\nPlain');
    const vtt = formatSubtitles(placed, 'vtt');
    expect(vtt).toContain('--> 00:00:01.000 align:start line:10%');
    expect(vtt).toContain('00:00:02.000\nPlain');
  });

  it('round-trips through the parser in both formats', () => {
    const placed = [
      { startMs: 250, endMs: 1750, text: 'Hello', align: 'right' as const, vAlign: 'middle' as const },
      { startMs: 2000, endMs: 4000, text: 'Second\ncue' },
    ];
    expect(parseSubtitles(formatSubtitles(placed, 'srt'))).toEqual(placed);
    expect(parseSubtitles(formatSubtitles(placed, 'vtt'))).toEqual(placed);
  });
});

describe('formatSubtitles - unsafe cue text', () => {
  it('drops blank lines inside a cue, which would otherwise end it early', () => {
    const cues = [{ startMs: 0, endMs: 1000, text: 'One\n\n  \nTwo' }];
    expect(formatSubtitles(cues, 'srt')).toBe('1\n00:00:00,000 --> 00:00:01,000\nOne\nTwo\n');
    const expected = [{ startMs: 0, endMs: 1000, text: 'One\nTwo' }];
    expect(parseSubtitles(formatSubtitles(cues, 'srt'))).toEqual(expected);
    expect(parseSubtitles(formatSubtitles(cues, 'vtt'))).toEqual(expected);
  });

  it('escapes "-->" in WebVTT cue text', () => {
    const vtt = formatSubtitles([{ startMs: 0, endMs: 1000, text: 'A --> B' }], 'vtt');
    expect(vtt).toContain('\nA --&gt; B\n');
    // Only the timing line carries the arrow.
    expect(vtt.match(/-->/g)).toHaveLength(1);
  });
});

describe('decodeSubtitleBytes', () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,000\nÇa été déjà vu\n';

  const utf16 = (text: string, bigEndian: boolean): Uint8Array => {
    const out = new Uint8Array(2 + text.length * 2);
    out.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = bigEndian ? c >> 8 : c & 0xff;
      out[3 + i * 2] = bigEndian ? c & 0xff : c >> 8;
    }
    return out;
  };

  it('reads plain UTF-8', () => {
    expect(decodeSubtitleBytes(new TextEncoder().encode(srt))).toBe(srt);
  });

  it('strips a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(srt)]);
    expect(decodeSubtitleBytes(bytes)).toBe(srt);
  });

  it('reads UTF-16LE and UTF-16BE with a BOM', () => {
    expect(decodeSubtitleBytes(utf16(srt, false))).toBe(srt);
    expect(decodeSubtitleBytes(utf16(srt, true))).toBe(srt);
  });

  it('falls back to Windows-1252 when the bytes are not valid UTF-8', () => {
    // One byte per accented letter (Latin-1 range, identical in 1252): not UTF-8.
    const bytes = Uint8Array.from(srt, (ch) => ch.charCodeAt(0));
    expect(decodeSubtitleBytes(bytes)).toBe(srt);
    expect(parseSubtitles(decodeSubtitleBytes(bytes))[0]!.text).toBe('Ça été déjà vu');
  });
});
