import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { PlugZap } from 'lucide-react';
import { PlaybackEngine } from './PlaybackEngine';
import { useStore, getSelectedClip } from '../store/store';
import { Clip, ClipTransform, MediaAsset, Project } from '../types';
import {
  DEFAULT_TRANSFORM,
  clipEndMs,
  isTextClip,
  isGeneratedClip,
  outputDimensions,
  timelineToSourceMs,
} from '../model';
import { DestRect, clipDestRect, clipsAt, shapeClipRect, textClipRect } from './compositor';
import { clamp } from '../lib/time';
import {
  DEFAULT_SHAPE_FILL,
  MIN_DRAWN_SHAPE,
  PREVIEW_MARQUEE_MIN_PX,
  PREVIEW_ZOOM_STEP,
  clampView,
  type PreviewView,
  zoomViewAt,
  zoomViewToRect,
} from './view';

type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * Crop editor: the composited canvas already shows the CROPPED result, so
 * cropping needs a view of the whole source. This overlay paints the source
 * frame (nearest thumbnail to the playhead) and lets the crop rectangle be
 * dragged and resized directly on it, in source-normalized coordinates.
 */
function CropOverlay({ clip, asset }: { clip: Clip; asset: MediaAsset }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    handle: CropHandle;
    startNx: number;
    startNy: number;
    orig: ClipTransform['crop'];
    rect: DOMRect;
  } | null>(null);

  const tf = clip.transform ?? DEFAULT_TRANSFORM;
  const crop = tf.crop;
  const aspect = (asset.width ?? 16) / (asset.height ?? 9);

  // Frame shown under the rectangle: the thumbnail closest to the playhead.
  // Subscribing to the derived URL rather than to `currentTimeMs` keeps this in
  // sync while the playhead moves (reading getState() here left it frozen at
  // whatever time crop mode was opened) without re-rendering on every frame:
  // the selector runs per frame, but its result only changes when the playhead
  // crosses into the next thumbnail.
  const thumbs = asset.thumbnails;
  const thumb = useStore((s) => {
    if (thumbs.length === 0) return undefined;
    const srcMs = timelineToSourceMs(clip, s.currentTimeMs);
    const i = clamp(Math.round((srcMs / asset.durationMs) * (thumbs.length - 1)), 0, thumbs.length - 1);
    return thumbs[i];
  });

  const onDown = (e: React.PointerEvent, handle: CropHandle) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = frameRef.current!.getBoundingClientRect();
    const { nx, ny } = normPointIn(rect, e);
    useStore.getState().beginGesture();
    drag.current = { handle, startNx: nx, startNy: ny, orig: { ...crop }, rect };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { nx, ny } = normPointIn(d.rect, e);
    const dx = nx - d.startNx;
    const dy = ny - d.startNy;
    const o = d.orig;
    const MIN = 0.05;
    let next: ClipTransform['crop'];

    if (d.handle === 'move') {
      next = {
        ...o,
        x: clamp(o.x + dx, 0, 1 - o.w),
        y: clamp(o.y + dy, 0, 1 - o.h),
      };
    } else {
      // Corner resize: the opposite corner stays pinned.
      const left = d.handle === 'nw' || d.handle === 'sw';
      const top = d.handle === 'nw' || d.handle === 'ne';
      const right = o.x + o.w;
      const bottom = o.y + o.h;
      const nxC = clamp(left ? o.x + dx : right + dx, 0, 1);
      const nyC = clamp(top ? o.y + dy : bottom + dy, 0, 1);
      const x = left ? Math.min(nxC, right - MIN) : o.x;
      const y = top ? Math.min(nyC, bottom - MIN) : o.y;
      const w = left ? right - x : Math.max(MIN, nxC - o.x);
      const h = top ? bottom - y : Math.max(MIN, nyC - o.y);
      next = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
    }
    useStore.getState().updateClip(clip.id, { transform: { ...tf, crop: next } });
  };

  const onUp = () => {
    if (!drag.current) return;
    useStore.getState().endGesture();
    drag.current = null;
  };

  const handleCls =
    'pointer-events-auto absolute h-3.5 w-3.5 rounded-sm border border-zinc-900 bg-amber-300 shadow touch-none';

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/85"
      style={{ containerType: 'size' }}
    >
      <div
        ref={frameRef}
        className="relative max-h-full max-w-full touch-none"
        // Largest box of the source aspect that fits: cap width at both the full
        // width and the width that would fill the full height, so the frame never
        // gets stretched when the container is the "wrong" shape for this ratio.
        style={{ aspectRatio: `${aspect}`, width: `min(100%, ${aspect} * 100cqh)` }}
      >
        {thumb ? (
          <img src={thumb} className="h-full w-full object-fill opacity-70" alt="" draggable={false} />
        ) : (
          <div className="h-full w-full bg-zinc-800" />
        )}

        {/* The crop rectangle, in source-normalized coordinates. */}
        <div
          className="absolute cursor-move touch-none ring-2 ring-amber-300"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.w * 100}%`,
            height: `${crop.h * 100}%`,
            boxShadow: '0 0 0 9999px rgba(9,9,11,0.6)',
          }}
          onPointerDown={(e) => onDown(e, 'move')}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <div
              key={corner}
              className={`${handleCls} ${corner[0] === 'n' ? '-top-1.5' : '-bottom-1.5'} ${
                corner[1] === 'w' ? '-left-1.5' : '-right-1.5'
              } ${corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
              onPointerDown={(e) => onDown(e, corner)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
          ))}
        </div>

        <span className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-zinc-900/90 px-2.5 py-1 text-[11px] text-amber-200">
          {t('inspector.crop.hint')}
        </span>
      </div>
    </div>
  );
}

interface PreviewDrag {
  clipId: string;
  startNx: number;
  startNy: number;
  origX: number;
  origY: number;
  moved: boolean;
  /** Stage rect captured at pointerdown - see `normPointIn`. */
  rect: DOMRect;
}

interface PreviewResize {
  clipId: string;
  origScale: number;
  /** Center of the clip's dest rect, normalized to the stage. */
  centerNx: number;
  centerNy: number;
  /** Pointer distance from the center when the drag started. */
  startDist: number;
  /** Stage rect captured at pointerdown - see `normPointIn`. */
  rect: DOMRect;
}

/**
 * Normalize a pointer position against a rect captured when the drag started.
 *
 * Measuring on every pointermove instead forces a synchronous layout, and the
 * same handler then writes to the store (which commits DOM) - a read-after-
 * write cycle per event. The stage cannot move mid-drag: the pointer is
 * captured and its size is driven by the panel, not by anything the drag
 * changes.
 */
function normPointIn(rect: DOMRect, e: React.PointerEvent): { nx: number; ny: number } {
  return { nx: (e.clientX - rect.left) / rect.width, ny: (e.clientY - rect.top) / rect.height };
}

/** The clip with this id, without flattening every track on each lookup. */
function findClip(project: Project, clipId: string): Clip | null {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) return clip;
    }
  }
  return null;
}

/** Guide lines are recomputed on every pointermove but rarely actually change. */
function sameLines(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Bounding rect of a clip in output coordinates at a timeline time (null when unknown). */
function clipRectAt(
  clip: Clip,
  assets: Record<string, MediaAsset>,
  outW: number,
  outH: number,
  timeMs: number,
): DestRect | null {
  if (isTextClip(clip)) return textClipRect(clip, outW, outH);
  if (clip.kind === 'shape') return shapeClipRect(clip, outW, outH);
  if (clip.kind === 'solid') return { dx: 0, dy: 0, dw: outW, dh: outH };
  const asset = assets[clip.assetId];
  // The dest rect only depends on the source aspect ratio, known from the probe.
  if (!asset?.width || !asset?.height) return null;
  return clipDestRect(clip, asset.width, asset.height, outW, outH, timeMs);
}

/**
 * Time-driven overlays (selection outline + handles, disconnected-source badge).
 * Split into its own component that subscribes to `currentTimeMs` so that only
 * this small subtree re-renders each playback frame - the parent `PreviewCanvas`
 * (canvas, effects, drag handlers) stays off the 60fps path, matching how
 * `Playhead` and the transport timecode already avoid per-frame React work.
 */
function PreviewOverlays({
  project,
  assets,
  selectedClip,
  cropping,
  outW,
  outH,
  stageRef,
}: {
  project: Project;
  assets: Record<string, MediaAsset>;
  selectedClip: Clip | null;
  cropping: boolean;
  outW: number;
  outH: number;
  stageRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const resize = useRef<PreviewResize | null>(null);

  // A media clip visible right now that points at a disconnected source: the
  // canvas would otherwise just render black with no explanation. Plain scan
  // (no sort/alloc) since it runs every frame.
  const disconnectedNow =
    !cropping &&
    project.tracks.some(
      (tr) =>
        tr.kind === 'video' &&
        !tr.hidden &&
        tr.clips.some(
          (c) =>
            !isGeneratedClip(c) &&
            assets[c.assetId]?.disconnected &&
            currentTimeMs >= c.timelineStartMs &&
            currentTimeMs < clipEndMs(c),
        ),
    );

  // Selection outline: only when the selected clip is actually on screen now
  // (and not while the crop overlay covers the stage).
  const selectedRect =
    !cropping &&
    selectedClip &&
    currentTimeMs >= selectedClip.timelineStartMs &&
    currentTimeMs < clipEndMs(selectedClip) &&
    project.tracks.some(
      (tr) => tr.kind === 'video' && !tr.hidden && tr.clips.some((c) => c.id === selectedClip.id),
    )
      ? clipRectAt(selectedClip, assets, outW, outH, currentTimeMs)
      : null;

  /** Corner handle drag: rescale the clip around its center. */
  const onHandleDown = (e: React.PointerEvent, rect: DestRect, clip: Clip) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state = useStore.getState();
    state.beginGesture();
    const stageRect = stageRef.current!.getBoundingClientRect();
    const { nx, ny } = normPointIn(stageRect, e);
    const centerNx = (rect.dx + rect.dw / 2) / outW;
    const centerNy = (rect.dy + rect.dh / 2) / outH;
    resize.current = {
      clipId: clip.id,
      origScale: (clip.transform ?? DEFAULT_TRANSFORM).scale,
      centerNx,
      centerNy,
      startDist: Math.max(0.01, Math.hypot(nx - centerNx, ny - centerNy)),
      rect: stageRect,
    };
  };

  const onHandleMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r) return;
    const { nx, ny } = normPointIn(r.rect, e);
    const dist = Math.hypot(nx - r.centerNx, ny - r.centerNy);
    let scale = Math.min(8, Math.max(0.05, (r.origScale * dist) / r.startDist));
    // Magnetism: snap to the natural "fit-to-frame" scale (1.0) unless Shift is held.
    if (!e.shiftKey && Math.abs(scale - 1) < 0.03) scale = 1;
    const state = useStore.getState();
    const clip = findClip(state.project, r.clipId);
    if (!clip) return;
    const tf = clip.transform ?? DEFAULT_TRANSFORM;
    state.updateClip(r.clipId, { transform: { ...tf, scale } });
  };

  const onHandleUp = () => {
    if (!resize.current) return;
    useStore.getState().endGesture();
    resize.current = null;
  };

  return (
    <>
      {disconnectedNow && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-zinc-950/70 px-4 text-center">
          <PlugZap className="h-7 w-7 text-amber-300" />
          <p className="text-xs font-medium text-amber-100">{t('preview.disconnected')}</p>
        </div>
      )}
      {selectedRect && (
        <div
          className="pointer-events-none absolute rounded-sm ring-2 ring-sky-400/90"
          style={{
            left: `${(selectedRect.dx / outW) * 100}%`,
            top: `${(selectedRect.dy / outH) * 100}%`,
            width: `${(selectedRect.dw / outW) * 100}%`,
            height: `${(selectedRect.dh / outH) * 100}%`,
          }}
        >
          {/* Corner handles: drag to rescale the clip around its center. */}
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <div
              key={corner}
              className={`pointer-events-auto absolute h-3 w-3 rounded-sm border border-zinc-900 bg-sky-400 shadow ${
                corner[0] === 'n' ? '-top-1.5' : '-bottom-1.5'
              } ${corner[1] === 'w' ? '-left-1.5' : '-right-1.5'} ${
                corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'
              } touch-none`}
              onPointerDown={(e) => onHandleDown(e, selectedRect, selectedClip!)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** A pan in flight, from either the hand tool or a middle-button drag. */
interface ViewPan {
  startX: number;
  startY: number;
  origin: PreviewView;
}

/** Marquee drawn by the magnifier, in viewport-relative px. */
interface Marquee {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Output monitor + direct manipulation: dragging a clip in the preview moves
 * its transform position, the wheel over the preview scales the selected clip.
 * The hit-test and the selection outline reuse the compositor's dest-rect math,
 * expressed in % of the canvas so no pixel measuring is needed.
 *
 * The camera (`previewView`) is a CSS transform on the stage, so it costs the
 * clip-manipulation code nothing: every gesture normalizes against the stage's
 * bounding rect (see `normPointIn`), which already carries the zoom and pan.
 * Panning and zooming therefore need no changes to the drag/crop/handle math.
 *
 * The parent deliberately does NOT subscribe to `currentTimeMs`: the canvas is
 * painted imperatively by `PlaybackEngine`, so the only per-frame React work
 * belongs to `PreviewOverlays`. Handlers read the live time via getState().
 */
export function PreviewCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<PreviewDrag | null>(null);
  const wheelGesture = useRef<number | null>(null);
  const pan = useRef<ViewPan | null>(null);
  const zoomDrag = useRef<{ startX: number; startY: number; altKey: boolean } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const shapeDraw = useRef<{ startNx: number; startNy: number; rect: DOMRect } | null>(null);
  /** The shape being drawn, in stage-normalized coords (0..1). */
  const [drawBox, setDrawBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Alignment guides drawn while dragging in the preview (normalized stage coords).
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });

  const project = useStore((s) => s.project);
  const assets = useStore((s) => s.assets);
  const selectedClip = useStore(getSelectedClip);
  const cropEditing = useStore((s) => s.cropEditing);
  const previewTool = useStore((s) => s.previewTool);
  const previewView = useStore((s) => s.previewView);
  const previewShapeKind = useStore((s) => s.previewShapeKind);

  const { width: outW, height: outH } = outputDimensions(project.aspectRatio);

  // Crop mode only makes sense for a media clip whose source we can show.
  const cropAsset = selectedClip && !isGeneratedClip(selectedClip) ? assets[selectedClip.assetId] : undefined;
  const croppingClip = cropEditing && selectedClip && cropAsset ? selectedClip : null;

  useEffect(() => {
    const engine = new PlaybackEngine(canvasRef.current!);
    return () => engine.dispose();
  }, []);

  /** Topmost visible clip under a normalized point at the current time. */
  const hitTest = (nx: number, ny: number): Clip | null => {
    const timeMs = useStore.getState().currentTimeMs;
    const px = nx * outW;
    const py = ny * outH;
    // Top lane paints last, so scan tracks top-down to hit the frontmost clip.
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.hidden || (track.opacity ?? 1) <= 0) continue;
      const visible = clipsAt(track.clips, timeMs);
      for (let i = visible.length - 1; i >= 0; i--) {
        const clip = visible[i]!;
        const r = clipRectAt(clip, assets, outW, outH, timeMs);
        if (r && px >= r.dx && px <= r.dx + r.dw && py >= r.dy && py <= r.dy + r.dh) {
          return clip;
        }
      }
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The crop overlay owns the pointer while it is up.
    if (croppingClip) return;
    // Hand and magnifier drive the camera: the viewport handler owns the gesture.
    if (previewTool !== 'select') return;
    const rect = stageRef.current!.getBoundingClientRect();
    const { nx, ny } = normPointIn(rect, e);
    const clip = hitTest(nx, ny);
    if (!clip) return;
    const state = useStore.getState();
    state.selectClip(clip.id);
    state.beginGesture();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const t = clip.transform ?? DEFAULT_TRANSFORM;
    drag.current = {
      clipId: clip.id,
      startNx: nx,
      startNy: ny,
      origX: t.x,
      origY: t.y,
      moved: false,
      rect,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { nx, ny } = normPointIn(d.rect, e);
    if (!d.moved && Math.abs(nx - d.startNx) < 0.004 && Math.abs(ny - d.startNy) < 0.004) return;
    d.moved = true;
    const state = useStore.getState();
    const clip = findClip(state.project, d.clipId);
    if (!clip) return;
    const tf = clip.transform ?? DEFAULT_TRANSFORM;
    let x = d.origX + (nx - d.startNx);
    let y = d.origY + (ny - d.startNy);

    // Smart guides: the transform x/y IS the clip's normalized center, so snap
    // it to the frame center and to the frame edges (via the clip's half-size).
    // Holding Shift disables the magnetism. Fuchsia lines mark each active snap.
    const rect = clipRectAt(clip, assets, outW, outH, state.currentTimeMs);
    const vLines: number[] = [];
    const hLines: number[] = [];
    if (!e.shiftKey && rect) {
      const TH = 0.012;
      const halfW = rect.dw / outW / 2;
      const halfH = rect.dh / outH / 2;
      const xCands: [number, number][] = [
        [0.5, 0.5],
        [halfW, 0],
        [1 - halfW, 1],
      ];
      for (const [center, guide] of xCands) {
        if (Math.abs(x - center) <= TH) {
          x = center;
          vLines.push(guide);
          break;
        }
      }
      const yCands: [number, number][] = [
        [0.5, 0.5],
        [halfH, 0],
        [1 - halfH, 1],
      ];
      for (const [center, guide] of yCands) {
        if (Math.abs(y - center) <= TH) {
          y = center;
          hLines.push(guide);
          break;
        }
      }
    }
    // Returning the previous object bails React out: without this, every
    // pointermove re-rendered the whole stage subtree to redraw guides that
    // are almost always identical (and usually empty).
    setGuides((prev) =>
      sameLines(prev.v, vLines) && sameLines(prev.h, hLines) ? prev : { v: vLines, h: hLines },
    );

    state.updateClip(d.clipId, {
      transform: {
        ...tf,
        x: Math.min(1.5, Math.max(-0.5, x)),
        y: Math.min(1.5, Math.max(-0.5, y)),
      },
    });
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    useStore.getState().endGesture();
    drag.current = null;
    setGuides((prev) => (prev.v.length === 0 && prev.h.length === 0 ? prev : { v: [], h: [] }));
  };

  /** Clamp against the live viewport/stage geometry, then commit. */
  const commitView = (view: PreviewView) => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    if (!viewport || !stage) return;
    // offsetWidth/Height are layout sizes, which the camera transform does not
    // affect - exactly the un-zoomed stage size `clampView` expects.
    useStore
      .getState()
      .setPreviewView(
        clampView(view, viewport.getBoundingClientRect(), stage.offsetWidth, stage.offsetHeight),
      );
  };

  /**
   * Camera gestures. They live on the viewport, not the stage, so a pan keeps
   * tracking once the pointer leaves the frame - and so the magnifier can
   * marquee across the empty letterbox around it.
   */
  const onViewportPointerDown = (e: React.PointerEvent) => {
    const state = useStore.getState();
    if (state.cropEditing) return;
    const mouse = e.pointerType === 'mouse';
    // Middle-drag pans whatever the active tool is: the universal NLE reflex,
    // and Space is already taken by play/pause.
    const middle = mouse && e.button === 1;
    if (mouse && !middle && e.button !== 0) return;

    if (middle || (!middle && state.previewTool === 'hand')) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      pan.current = { startX: e.clientX, startY: e.clientY, origin: state.previewView };
      return;
    }
    if (state.previewTool === 'zoom') {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      zoomDrag.current = { startX: e.clientX, startY: e.clientY, altKey: e.altKey };
      return;
    }
    if (state.previewTool === 'shape') {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      // Normalized against the STAGE, not the viewport: the shape is authored in
      // output coordinates, and the stage rect already carries the camera.
      const rect = stageRef.current!.getBoundingClientRect();
      const { nx, ny } = normPointIn(rect, e);
      shapeDraw.current = { startNx: nx, startNy: ny, rect };
    }
  };

  const onViewportPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (p) {
      commitView({
        zoom: p.origin.zoom,
        x: p.origin.x + (e.clientX - p.startX),
        y: p.origin.y + (e.clientY - p.startY),
      });
      return;
    }
    const s = shapeDraw.current;
    if (s) {
      const { nx, ny } = normPointIn(s.rect, e);
      let w = Math.abs(nx - s.startNx);
      let h = Math.abs(ny - s.startNy);
      // Shift constrains to a square/circle - in OUTPUT pixels, not in these
      // normalized units, which are stretched by the frame's aspect ratio.
      if (e.shiftKey) {
        const side = Math.max(w * outW, h * outH);
        w = side / outW;
        h = side / outH;
      }
      setDrawBox({
        x: (e.shiftKey ? (nx < s.startNx ? s.startNx - w : s.startNx) : Math.min(nx, s.startNx)),
        y: (e.shiftKey ? (ny < s.startNy ? s.startNy - h : s.startNy) : Math.min(ny, s.startNy)),
        w,
        h,
      });
      return;
    }
    const z = zoomDrag.current;
    if (!z) return;
    const viewport = viewportRef.current!.getBoundingClientRect();
    setMarquee({
      left: Math.min(z.startX, e.clientX) - viewport.left,
      top: Math.min(z.startY, e.clientY) - viewport.top,
      width: Math.abs(e.clientX - z.startX),
      height: Math.abs(e.clientY - z.startY),
    });
  };

  const onViewportPointerUp = () => {
    if (pan.current) {
      pan.current = null;
      return;
    }
    if (shapeDraw.current) {
      shapeDraw.current = null;
      const box = drawBox;
      setDrawBox(null);
      // A stray click (or a drag too small to see) must not litter the timeline.
      if (!box || box.w < MIN_DRAWN_SHAPE || box.h < MIN_DRAWN_SHAPE) return;
      const state = useStore.getState();
      state.addShapeClip(
        {
          kind: state.previewShapeKind,
          w: box.w,
          h: box.h,
          fill: DEFAULT_SHAPE_FILL,
          strokeWidth: 0,
          radius: 0,
          sides: 5,
        },
        { x: box.x + box.w / 2, y: box.y + box.h / 2 },
      );
      // Hand the shape straight over to the select tool: it is already selected,
      // so the corner handles and the inspector are usable without a detour.
      state.setPreviewTool('select');
      return;
    }
    const z = zoomDrag.current;
    if (!z) return;
    zoomDrag.current = null;
    const viewport = viewportRef.current!.getBoundingClientRect();
    const view = useStore.getState().previewView;
    if (marquee && marquee.width >= PREVIEW_MARQUEE_MIN_PX && marquee.height >= PREVIEW_MARQUEE_MIN_PX) {
      commitView(
        zoomViewToRect(
          view,
          { ...marquee, left: marquee.left + viewport.left, top: marquee.top + viewport.top },
          viewport,
        ),
      );
    } else {
      // Too short to be a marquee: treat it as a click, one rung at the pointer.
      const factor = z.altKey ? 1 / PREVIEW_ZOOM_STEP : PREVIEW_ZOOM_STEP;
      commitView(zoomViewAt(view, view.zoom * factor, z.startX, z.startY, viewport));
    }
    setMarquee(null);
  };

  // A new aspect ratio relays out the stage, so a camera framed on the old one
  // would land somewhere arbitrary: start from the fitted frame again.
  useEffect(() => {
    useStore.getState().resetPreviewView();
  }, [outW, outH]);

  // Wheel over the preview scales the selected clip - or drives the camera when
  // Ctrl/Cmd is held or a camera tool is active. Native listener: React's
  // onWheel is passive, and both paths must preventDefault to not scroll the page.
  useEffect(() => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    if (!viewport || !stage) return;
    const onWheel = (e: WheelEvent) => {
      const state = useStore.getState();
      if (state.cropEditing) return;

      // Ctrl/Cmd + wheel is "zoom the view" everywhere in the app (the timeline
      // reads it the same way), and the camera tools make it the default.
      if (e.ctrlKey || e.metaKey || state.previewTool !== 'select') {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const view = state.previewView;
        const next = zoomViewAt(view, view.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, rect);
        state.setPreviewView(clampView(next, rect, stage.offsetWidth, stage.offsetHeight));
        return;
      }

      const clip = getSelectedClip(state);
      if (!clip) return;
      e.preventDefault();
      if (wheelGesture.current === null) state.beginGesture();
      else window.clearTimeout(wheelGesture.current);
      wheelGesture.current = window.setTimeout(() => {
        useStore.getState().endGesture();
        wheelGesture.current = null;
      }, 350);
      const tf = clip.transform ?? DEFAULT_TRANSFORM;
      const scale = Math.min(8, Math.max(0.05, tf.scale * Math.exp(-e.deltaY * 0.0012)));
      state.updateClip(clip.id, { transform: { ...tf, scale } });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  const cameraCursor =
    previewTool === 'hand'
      ? 'cursor-grab active:cursor-grabbing'
      : previewTool === 'zoom'
        ? 'cursor-zoom-in'
        : previewTool === 'shape'
          ? 'cursor-crosshair'
          : '';

  return (
    <div
      ref={viewportRef}
      className={`relative flex h-full w-full items-center justify-center overflow-hidden bg-zinc-950 p-1 ${cameraCursor}`}
      style={{ containerType: 'size' }}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerUp}
      onPointerCancel={onViewportPointerUp}
      // Middle-click otherwise arms the browser's autoscroll puck on Windows.
      onAuxClick={(e) => e.preventDefault()}
    >
      <div
        ref={stageRef}
        className="relative max-h-full max-w-full touch-none"
        // Fit the output frame inside the panel without distortion: the width is
        // capped at both 100% and the width that fills the full panel height at
        // this aspect ratio, so switching ratios never stretches the image.
        style={{
          aspectRatio: `${outW} / ${outH}`,
          width: `min(100%, ${outW / outH} * 100cqh)`,
          // The camera. Around the centre, so pan 0 is the fitted position, and
          // on the stage itself so its bounding rect carries the zoom for every
          // pointer gesture underneath.
          transform: `translate(${previewView.x}px, ${previewView.y}px) scale(${previewView.zoom})`,
          transformOrigin: 'center',
          willChange: 'transform',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="h-full w-full rounded-lg shadow-lg shadow-black/50" />
        {croppingClip && cropAsset && <CropOverlay clip={croppingClip} asset={cropAsset} />}
        {/* Smart-guide lines while dragging a clip in the preview. */}
        {(guides.v.length > 0 || guides.h.length > 0) && (
          <div className="pointer-events-none absolute inset-0 z-20">
            {guides.v.map((g, i) => (
              <div
                key={`v${i}`}
                className="absolute inset-y-0 w-px bg-fuchsia-400/90"
                style={{ left: `${g * 100}%` }}
              />
            ))}
            {guides.h.map((g, i) => (
              <div
                key={`h${i}`}
                className="absolute inset-x-0 h-px bg-fuchsia-400/90"
                style={{ top: `${g * 100}%` }}
              />
            ))}
          </div>
        )}
        {/* The shape being drawn. Inside the stage, so it is expressed in the
            same normalized coordinates the clip will be authored in. */}
        {drawBox && (
          <div
            className="pointer-events-none absolute z-20 border-2 border-sky-300 bg-sky-400/25"
            style={{
              left: `${drawBox.x * 100}%`,
              top: `${drawBox.y * 100}%`,
              width: `${drawBox.w * 100}%`,
              height: `${drawBox.h * 100}%`,
              borderRadius: previewShapeKind === 'ellipse' ? '50%' : undefined,
            }}
          />
        )}
        <PreviewOverlays
          project={project}
          assets={assets}
          selectedClip={selectedClip}
          cropping={croppingClip !== null}
          outW={outW}
          outH={outH}
          stageRef={stageRef}
        />
      </div>

      {/* Magnifier marquee. Outside the stage, so it is not itself zoomed. */}
      {marquee && (
        <div
          className="pointer-events-none absolute z-30 border border-sky-300/90 bg-sky-400/15"
          style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
        />
      )}
    </div>
  );
}
