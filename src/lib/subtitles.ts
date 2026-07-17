/** A parsed subtitle cue, timeline-ready. */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export function isSubtitleFile(file: File): boolean {
  return /\.(srt|vtt|ass|ssa)$/i.test(file.name);
}

/** "01:02:03,450", "02:03.450" or "03,450" → milliseconds. */
function parseTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+):)?(\d+):(\d+)[.,](\d{1,3})$/);
  if (!m) return null;
  // Groups 2-4 (min, s, frac) are mandatory in the pattern; group 1 (h) is optional.
  const h = m[1] ?? '0';
  return (
    Number(h) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4]!.padEnd(3, '0'))
  );
}

/** Strip inline markup: HTML-ish tags (<i>, <font …>) and VTT voice spans. */
function cleanText(lines: string[]): string {
  return lines
    .map((l) => l.replace(/<[^>]+>/g, '').replace(/\{\\an\d\}/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

/** "1:02:03.45" (ASS centisecond timestamps) → milliseconds. */
function parseAssTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,2})$/);
  if (!m) return null;
  return (
    Number(m[1]) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4]!.padEnd(2, '0')) * 10
  );
}

/**
 * Parse SubStation Alpha (.ass/.ssa) content: "Dialogue:" lines from the
 * [Events] section. The field order comes from the section's "Format:" line
 * (falling back to the standard order); override tags ({\...}) are stripped,
 * \N and \n become line breaks, \h a space.
 */
function parseAssSubtitles(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = content.replace(/\r/g, '').split('\n');
  // Standard v4+ field order; a Format: line in [Events] overrides it.
  let fields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  let inEvents = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[(.+)\]$/);
    if (section) {
      inEvents = section[1]!.toLowerCase() === 'events';
      continue;
    }
    if (!inEvents) continue;
    const format = line.match(/^Format\s*:\s*(.+)$/i);
    if (format) {
      fields = format[1]!.split(',').map((f) => f.trim());
      continue;
    }
    const dialogue = line.match(/^Dialogue\s*:\s*(.+)$/i);
    if (!dialogue) continue;
    // Text is always the LAST field and may itself contain commas.
    const parts = dialogue[1]!.split(',');
    if (parts.length < fields.length) continue;
    const textIdx = fields.indexOf('Text');
    const startIdx = fields.indexOf('Start');
    const endIdx = fields.indexOf('End');
    if (textIdx === -1 || startIdx === -1 || endIdx === -1) continue;
    const startMs = parseAssTimestamp(parts[startIdx] ?? '');
    const endMs = parseAssTimestamp(parts[endIdx] ?? '');
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = parts
      .slice(textIdx)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!text) continue;
    cues.push({ startMs, endMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Parse SRT, WebVTT or SubStation Alpha (.ass/.ssa) content into cues.
 * Tolerant: skips numeric counters, the WEBVTT header, NOTE/STYLE blocks and
 * any block without a valid "start --> end" line. Returns cues sorted by
 * start time.
 */
export function parseSubtitles(content: string): SubtitleCue[] {
  const normalized = content.replace(/^﻿/, '');
  // SubStation Alpha files carry Dialogue: events (usually under [Events]).
  if (/^\s*(\[Script Info\]|Dialogue\s*:)/im.test(normalized)) {
    return parseAssSubtitles(normalized);
  }
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;
    const [rawStart, rawEnd] = lines[timingIdx]!.split('-->');
    // VTT allows settings after the end time ("00:02.000 line:0 align:start").
    const startMs = parseTimestamp(rawStart ?? '');
    const endMs = parseTimestamp((rawEnd ?? '').trim().split(/\s+/)[0] ?? '');
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = cleanText(lines.slice(timingIdx + 1));
    if (!text) continue;
    cues.push({ startMs, endMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}
