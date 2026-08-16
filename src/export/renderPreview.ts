/**
 * Worker-side tap that snapshots the frame a render has just composited, so the
 * preview monitor can show the export advancing.
 *
 * Shared by the serial render and by every segment worker, for the same reason
 * `FrameRenderer` is: there is one way a render frame is captured, and it is
 * this one.
 *
 * Two rules keep it off the critical path. It samples on a clock rather than
 * per frame - a 60 fps render would otherwise hand the main thread sixty
 * bitmaps a second to draw eight of - and it never blocks the loop: the capture
 * is fired and forgotten, with one in flight at a time so the snapshots cannot
 * arrive out of order and a slow copy simply drops its turn.
 */

/** Width a snapshot is downscaled to, in px. A monitor, not a second encoder. */
export const RENDER_PREVIEW_WIDTH = 480;

/** Shortest gap between two snapshots (~8 per second). */
export const RENDER_PREVIEW_INTERVAL_MS = 120;

export class RenderPreviewTap {
  /** A capture is in flight - see the ordering rule above. */
  private busy = false;
  private lastAt = 0;

  constructor(
    private readonly canvas: OffscreenCanvas,
    /** First timeline ms of the whole render, so the readout is a timeline position. */
    private readonly startMs: number,
    private readonly fps: number,
    private readonly emit: (bitmap: ImageBitmap, timeMs: number) => void,
  ) {}

  /**
   * Offer the canvas as it stands. `frame` is counted from the first frame of
   * the whole render, not of the caller's slice.
   *
   * Must be called once the frame has been handed to the encoder: `add` copies
   * the canvas into a `VideoFrame` synchronously, so capturing afterwards
   * cannot make the encoder wait on this.
   */
  capture(frame: number): void {
    if (this.busy) return;
    const now = performance.now();
    if (now - this.lastAt < RENDER_PREVIEW_INTERVAL_MS) return;
    this.lastAt = now;
    this.busy = true;

    const timeMs = this.startMs + (frame * 1000) / this.fps;
    const { width, height } = this.canvas;
    const w = Math.min(RENDER_PREVIEW_WIDTH, width);
    const h = Math.max(1, Math.round((w * height) / width));
    void createImageBitmap(this.canvas, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'medium',
    })
      .then((bitmap) => {
        this.emit(bitmap, timeMs);
      })
      .catch(() => {
        // A dropped snapshot is a missing picture, never a failed render.
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
