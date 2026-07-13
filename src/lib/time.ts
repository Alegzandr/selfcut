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

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
