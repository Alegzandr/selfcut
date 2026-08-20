import type { ClipRedaction } from '../types';

/**
 * The region a new redaction starts as: a soft-edged ellipse, a quarter of the
 * frame wide, blurring hard enough to be unmistakably doing its job.
 *
 * An ellipse because the overwhelming first use is a face; `blur` because it is
 * the discreet default and the mosaic is one click away; `amount` well past half
 * because a redaction that leaves its subject recognizable has failed at the one
 * thing it was added to do — dialling it back is a choice, dialling it up is a
 * repair.
 */
export function defaultRedaction(center?: { x: number; y: number }): Omit<ClipRedaction, 'id'> {
  return {
    mode: 'blur',
    amount: 0.7,
    shape: 'ellipse',
    x: center?.x ?? 0.5,
    y: center?.y ?? 0.5,
    w: 0.25,
    h: 0.25,
    // Enough of an edge to hide the seam and the jitter of a tracked region,
    // little enough that the blur still stops where the shape says it does.
    feather: 0.02,
    invert: false,
  };
}
