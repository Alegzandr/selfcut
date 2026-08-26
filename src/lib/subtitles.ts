import type { TextAlign } from '../types';

/** Vertical band a cue asks to sit in. */
export type SubtitleVAlign = 'top' | 'middle' | 'bottom';

/** A parsed subtitle cue, timeline-ready. */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
  /** Only set when the file states one; undefined keeps the caption default. */
  align?: TextAlign;
  vAlign?: SubtitleVAlign;
}

/** Placement a cue carries, from an override tag or a WebVTT cue setting. */
type Placement = { align?: TextAlign; vAlign?: SubtitleVAlign };

const H_BY_COLUMN: TextAlign[] = ['left', 'center', 'right'];

/**
 * SubStation placement override tags, as they appear inline in the text of a
 * Dialogue line (and, in practice, in plenty of SRT files too).
 *
 * `\anN` is the v4+ numpad layout: 1-3 bottom, 4-6 middle, 7-9 top, cycling
 * left/center/right. `\aN` is the legacy SSA numbering, which orders the bands
 * differently — hence the explicit table rather than shared arithmetic.
 */
const LEGACY_A_TAGS: Record<number, Placement> = {
  1: { align: 'left', vAlign: 'bottom' },
  2: { align: 'center', vAlign: 'bottom' },
  3: { align: 'right', vAlign: 'bottom' },
  5: { align: 'left', vAlign: 'top' },
  6: { align: 'center', vAlign: 'top' },
  7: { align: 'right', vAlign: 'top' },
  9: { align: 'left', vAlign: 'middle' },
  10: { align: 'center', vAlign: 'middle' },
  11: { align: 'right', vAlign: 'middle' },
};

/** Read the first placement override in a cue's text, if any. */
function placementFromTags(text: string): Placement {
  const an = text.match(/\{\\an([1-9])\}/);
  if (an) {
    const n = Number(an[1]) - 1;
    return { align: H_BY_COLUMN[n % 3], vAlign: (['bottom', 'middle', 'top'] as const)[Math.floor(n / 3)] };
  }
  const legacy = text.match(/\{\\a(\d{1,2})\}/);
  if (legacy) return LEGACY_A_TAGS[Number(legacy[1])] ?? {};
  return {};
}

/**
 * Read a WebVTT cue's settings (everything after the end timestamp), e.g.
 * "00:02.000 --> 00:04.000 align:start line:0".
 *
 * `line` is a percentage when suffixed with %, otherwise a line index: negative
 * counts up from the bottom, non-negative down from the top. Only the band
 * matters here, since a cue becomes a clip positioned by fraction.
 */
function placementFromVttSettings(settings: string): Placement {
  const out: Placement = {};
  const align = settings.match(/\balign:(start|left|center|middle|end|right)\b/i)?.[1]?.toLowerCase();
  if (align === 'start' || align === 'left') out.align = 'left';
  else if (align === 'end' || align === 'right') out.align = 'right';
  else if (align) out.align = 'center';

  const line = settings.match(/\bline:(-?\d+(?:\.\d+)?)(%?)/);
  if (line) {
    const value = Number(line[1]);
    if (line[2] === '%') out.vAlign = value < 34 ? 'top' : value < 67 ? 'middle' : 'bottom';
    else out.vAlign = value < 0 ? 'bottom' : 'top';
  }
  return out;
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
    .map((l) => l.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim())
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
    const raw = parts.slice(textIdx).join(',');
    const text = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!text) continue;
    // Read the placement BEFORE the override blocks are stripped.
    cues.push({ startMs, endMs, text, ...placementFromTags(raw) });
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
    const [rawEndTime, ...settings] = (rawEnd ?? '').trim().split(/\s+/);
    const startMs = parseTimestamp(rawStart ?? '');
    const endMs = parseTimestamp(rawEndTime ?? '');
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const body = lines.slice(timingIdx + 1);
    const text = cleanText(body);
    if (!text) continue;
    // An inline override tag is more specific than a cue setting, so it wins.
    const placement = {
      ...placementFromVttSettings(settings.join(' ')),
      ...placementFromTags(body.join('\n')),
    };
    cues.push({ startMs, endMs, text, ...placement });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** The two formats the exporter writes back out. */
export type SubtitleFormat = 'srt' | 'vtt';

/** Numpad `\anN` code for a placement, the notation both SRT and ASS readers know. */
const AN_CODE: Record<SubtitleVAlign, Record<TextAlign, number>> = {
  bottom: { left: 1, center: 2, right: 3 },
  middle: { left: 4, center: 5, right: 6 },
  top: { left: 7, center: 8, right: 9 },
};

/** Milliseconds → "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (WebVTT). */
function formatTimestamp(ms: number, sep: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor(clamped / 60_000) % 60;
  const s = Math.floor(clamped / 1000) % 60;
  const frac = clamped % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(frac, 3)}`;
}

/**
 * WebVTT cue settings for a placement, empty when the cue sits where a player
 * would put it anyway (bottom, centered).
 *
 * `line` is written as a percentage rather than a line index because a cue here
 * knows a band, not a row count: 10/50 land in the top and middle thirds the
 * parser reads back, whatever the player's line height.
 */
function vttSettings({ align, vAlign }: Placement): string {
  const parts: string[] = [];
  if (align === 'left') parts.push('align:start');
  else if (align === 'right') parts.push('align:end');
  if (vAlign === 'top') parts.push('line:10%');
  else if (vAlign === 'middle') parts.push('line:50%');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Write cues back out as SRT or WebVTT.
 *
 * Placement survives the round trip in each format's own notation: a cue
 * setting in VTT, an `\an` override tag in SRT — the same tag the parser reads,
 * and the one players that support positioning at all understand. A cue sitting
 * at the default (bottom, centered) carries no marker, so an ordinary caption
 * track exports as an ordinary file.
 */
export function formatSubtitles(cues: SubtitleCue[], format: SubtitleFormat): string {
  const sep = format === 'srt' ? ',' : '.';
  const blocks = cues.map((cue, i) => {
    const timing = `${formatTimestamp(cue.startMs, sep)} --> ${formatTimestamp(cue.endMs, sep)}`;
    if (format === 'vtt') {
      return `${timing}${vttSettings(cue)}\n${cue.text}`;
    }
    const placed = cue.align || cue.vAlign;
    const tag = placed ? `{\\an${AN_CODE[cue.vAlign ?? 'bottom'][cue.align ?? 'center']}}` : '';
    // SRT numbers its cues from 1; the counter is part of the format, not a hint.
    return `${i + 1}\n${timing}\n${tag}${cue.text}`;
  });
  const body = blocks.join('\n\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}
