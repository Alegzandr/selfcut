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

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
