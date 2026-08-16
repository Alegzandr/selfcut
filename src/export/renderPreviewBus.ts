/**
 * The frame a render is currently on, published to the preview monitor.
 *
 * A render can run for minutes with nothing on screen but whatever still the
 * playhead happened to be parked on, which stops meaning anything the moment
 * the export starts. The export worker sends a downscaled snapshot a few times
 * a second; this is where it lands, and the playback engine paints it in place
 * of its own composite for as long as one is set.
 *
 * Deliberately a module singleton rather than store state: the payload is an
 * ImageBitmap with an explicit lifetime, which is the one thing a snapshot in a
 * React store must never hold. Exactly one bitmap is live at a time - publishing
 * closes the one it replaces, and `clearRenderPreview` closes the last one - so
 * a finished render leaves nothing behind on the GPU.
 */
export interface RenderPreviewFrame {
  bitmap: ImageBitmap;
  /** Timeline position of that frame, for the readout on the monitor. */
  timeMs: number;
}

let current: RenderPreviewFrame | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function publishRenderFrame(bitmap: ImageBitmap, timeMs: number): void {
  current?.bitmap.close();
  current = { bitmap, timeMs };
  notify();
}

/** The render ended, failed or was canceled: hand the monitor back to the playhead. */
export function clearRenderPreview(): void {
  if (!current) return;
  current.bitmap.close();
  current = null;
  notify();
}

/**
 * The live snapshot, or null. Stable between publishes, which is what makes it
 * usable as a `useSyncExternalStore` snapshot.
 */
export function renderPreviewFrame(): RenderPreviewFrame | null {
  return current;
}

/**
 * Whether a render owns the monitor. A separate snapshot from the frame itself:
 * subscribers that only need the on/off state must not re-render on every one
 * of the eight snapshots a second.
 */
export function isRenderPreviewLive(): boolean {
  return current !== null;
}

export function subscribeRenderPreview(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
