import { clamp } from '../lib/time';
import { PREVIEW_COLORS } from '../lib/palette';
import { FULL_FRAME_BOUNDS, type HandleBounds } from './transformSnap';

/**
 * Which pointer gesture the preview stage answers to.
 *
 * `select` is the historical behaviour (hit-test, drag a clip's transform,
 * wheel-scale it). `hand` and `zoom` drive the *camera* instead - they move and
 * scale the view of the frame without touching a single clip.
 */
export type PreviewTool = 'select' | 'hand' | 'zoom' | 'shape';

/** Default look of a freshly drawn shape. */
export const DEFAULT_SHAPE_FILL = PREVIEW_COLORS.shapeFill;
/** Below this fraction of the frame a drag counts as a slip, not a shape. */
export const MIN_DRAWN_SHAPE = 0.01;

/**
 * Zoom/pan of the preview camera. Purely a way of looking at the output: it
 * never reaches the project, the history stack or the export, exactly like the
 * timeline's `pxPerSec`.
 *
 * Expressed as the CSS transform applied to the stage - `translate(x, y)` then
 * `scale(zoom)` around the stage centre - so the stage's own bounding rect
 * already carries the camera. Every existing hit-test and drag normalizes
 * against that rect (see `normPointIn`), which means clip manipulation keeps
 * working at any zoom with no extra math.
 */
export interface PreviewView {
  /** Scale of the stage; 1 = the frame fitted to the panel. */
  zoom: number;
  /** Stage translation in CSS px, relative to the centred position. */
  x: number;
  y: number;
}

export const PREVIEW_VIEW_RESET: PreviewView = { zoom: 1, x: 0, y: 0 };
export const MIN_PREVIEW_ZOOM = 0.25;
export const MAX_PREVIEW_ZOOM = 8;
/** One rung per click of the magnifier (Alt-click goes the other way). */
export const PREVIEW_ZOOM_STEP = 1.6;
/** Below this drag distance the magnifier counts as a click, not a marquee. */
export const PREVIEW_MARQUEE_MIN_PX = 12;

/** Distance of a client point from the viewport centre, where the stage sits at pan 0. */
function fromCentre(viewport: DOMRect, clientX: number, clientY: number): [number, number] {
  return [clientX - (viewport.left + viewport.width / 2), clientY - (viewport.top + viewport.height / 2)];
}

/**
 * Keep the view usable: the zoom stays in range, and the pan can always reach
 * every corner of an overflowing stage while never throwing the stage further
 * than half a viewport away - so a wildly panned frame can always be dragged
 * back into sight.
 *
 * `stageW`/`stageH` are the stage's *layout* size (offsetWidth/Height), which
 * the CSS transform does not affect.
 */
export function clampView(view: PreviewView, viewport: DOMRect, stageW: number, stageH: number): PreviewView {
  const zoom = clamp(view.zoom, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM);
  const maxX = Math.max(viewport.width / 2, (stageW * zoom - viewport.width) / 2);
  const maxY = Math.max(viewport.height / 2, (stageH * zoom - viewport.height) / 2);
  return { zoom, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

/** Margin kept between a clamped handle and the panel edge, in CSS px. */
const HANDLE_EDGE_INSET_PX = 10;

/**
 * The slice of the stage that is actually on screen, in normalized stage coords
 * (the same units the overlays are positioned in). Values fall outside 0..1
 * whenever the panel is larger than the output frame - which is the common case,
 * and exactly the room the corner handles need to follow a clip that overflows
 * the frame instead of being pinned to its border.
 *
 * Both rects are read live because the stage's is the *transformed* one: it
 * already carries the camera zoom and pan.
 */
export function visibleStageBounds(
  viewport: DOMRect,
  stage: DOMRect,
  insetPx = HANDLE_EDGE_INSET_PX,
): HandleBounds {
  if (stage.width <= 0 || stage.height <= 0) return FULL_FRAME_BOUNDS;
  // A viewport narrower than twice the inset would invert the bounds; falling
  // back to the frame keeps the handles somewhere sane.
  if (viewport.width <= insetPx * 2 || viewport.height <= insetPx * 2) return FULL_FRAME_BOUNDS;
  return {
    minX: (viewport.left + insetPx - stage.left) / stage.width,
    maxX: (viewport.right - insetPx - stage.left) / stage.width,
    minY: (viewport.top + insetPx - stage.top) / stage.height,
    maxY: (viewport.bottom - insetPx - stage.top) / stage.height,
  };
}

/**
 * Zoom to `zoom` while pinning the frame point under (clientX, clientY).
 *
 * A stage-local point `q` lands at `s = pan + zoom * q` on screen. Holding `s`
 * fixed and solving for the new pan gives `pan' = s - (zoom'/zoom) * (s - pan)`.
 */
export function zoomViewAt(
  view: PreviewView,
  zoom: number,
  clientX: number,
  clientY: number,
  viewport: DOMRect,
): PreviewView {
  const z = clamp(zoom, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM);
  const [sx, sy] = fromCentre(viewport, clientX, clientY);
  const k = z / view.zoom;
  return { zoom: z, x: sx - k * (sx - view.x), y: sy - k * (sy - view.y) };
}

/**
 * Zoom so the dragged rectangle (client coords) fills the viewport: scale by
 * whichever axis is the tighter fit, then centre the rectangle's midpoint.
 */
export function zoomViewToRect(
  view: PreviewView,
  rect: { left: number; top: number; width: number; height: number },
  viewport: DOMRect,
): PreviewView {
  const fit = Math.min(viewport.width / rect.width, viewport.height / rect.height);
  const z = clamp(view.zoom * fit, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM);
  const [sx, sy] = fromCentre(viewport, rect.left + rect.width / 2, rect.top + rect.height / 2);
  // The stage-local point the rectangle is centred on, re-pinned to the middle.
  return { zoom: z, x: (-z * (sx - view.x)) / view.zoom, y: (-z * (sy - view.y)) / view.zoom };
}

export function isViewReset(view: PreviewView): boolean {
  return view.zoom === 1 && view.x === 0 && view.y === 0;
}
