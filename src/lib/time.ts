/** Format a time in ms → "m:ss.d" (tenths). */
export function formatTime(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const tenths = Math.floor((totalSec * 10) % 10);
  return `${m}:${s.toString().padStart(2, '0')}.${tenths}`;
}

/** Format a time in ms → "m:ss" (for the ruler). */
export function formatTimeShort(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format a time in ms → "m:ss:ff" timecode at the given frame rate. */
export function formatTimecode(ms: number, fps: number): string {
  const { main, frames } = formatTimecodeParts(ms, fps);
  return `${main}:${frames}`;
}

/**
 * Timecode split into "m:ss" + frame count, so the UI can de-emphasize the
 * frames - "0:03:57" read as one string looks like 3 min 57 s.
 */
export function formatTimecodeParts(ms: number, fps: number): { main: string; frames: string } {
  const totalSec = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.floor((totalSec - Math.floor(totalSec)) * fps);
  return { main: `${m}:${s.toString().padStart(2, '0')}`, frames: f.toString().padStart(2, '0') };
}

/** How the transport readout spells time out - a user preference. */
export type TimeFormat = 'timecode' | 'decimal';

/**
 * Time split into main + trailing sub-part, honouring the display preference:
 * timecode keeps the frame count in `frames` (de-emphasized by the readout),
 * decimal folds the tenths straight into `main` and leaves `frames` empty.
 */
export function formatClockParts(
  ms: number,
  fps: number,
  format: TimeFormat,
): { main: string; frames: string } {
  if (format === 'decimal') return { main: formatTime(ms), frames: '' };
  return formatTimecodeParts(ms, fps);
}

/** Single-string time honouring the display preference. */
export function formatClock(ms: number, fps: number, format: TimeFormat): string {
  return format === 'decimal' ? formatTime(ms) : formatTimecode(ms, fps);
}

/**
 * Parse a typed time back into ms, mirroring what the readout shows. Returns
 * null when the text isn't a time at all, so the caller can reject the entry
 * instead of silently seeking to 0.
 *
 * Accepted: "12" (seconds), "1:23", "1:23:12" (m:ss:frames). A trailing "."
 * group means frames in timecode mode and fractional seconds in decimal mode,
 * matching how each format renders - "1:23.12" reads as the user sees it.
 */
export function parseClock(text: string, fps: number, format: TimeFormat): number | null {
  const input = text.trim().replace(',', '.');

  // m:ss:ff - a third colon group is always frames, in either display format.
  const tc = /^(\d+):(\d+):(\d+)$/.exec(input);
  if (tc) {
    const [, m = '0', s = '0', f = '0'] = tc;
    return (Number(m) * 60 + Number(s)) * 1000 + framesToMs(Number(f), fps);
  }

  // "12", "1:23", "1:23.45" - the trailing group reads per the display format.
  const plain = /^(?:(\d+):)?(\d+)(?:\.(\d+))?$/.exec(input);
  if (!plain) return null;
  const [, m = '0', s = '0', frac] = plain;
  const base = (Number(m) * 60 + Number(s)) * 1000;
  if (frac === undefined) return base;
  return base + (format === 'timecode' ? framesToMs(Number(frac), fps) : Number(`0.${frac}`) * 1000);
}

/** Frames → ms, capping at fps-1 so "0:01.99" at 30 fps can't overflow a second. */
function framesToMs(frames: number, fps: number): number {
  return (Math.min(frames, fps - 1) / fps) * 1000;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
