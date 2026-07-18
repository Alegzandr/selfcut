import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlugZap } from 'lucide-react';
import { PlaybackEngine } from './PlaybackEngine';
import { useStore, getSelectedClip } from '../store/store';
import { Clip, ClipTransform, MediaAsset } from '../types';
import {
  DEFAULT_TRANSFORM,
  clipEndMs,
  isTextClip,
  isGeneratedClip,
  outputDimensions,
  timelineToSourceMs,
} from '../model';
import { DestRect, clipDestRect, clipsAt, textClipRect } from './compositor';
import { clamp } from '../lib/time';

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
  } | null>(null);

  const tf = clip.transform ?? DEFAULT_TRANSFORM;
  const crop = tf.crop;
  const aspect = (asset.width ?? 16) / (asset.height ?? 9);

  // Frame shown under the rectangle: the thumbnail closest to the playhead.
  const srcMs = timelineToSourceMs(clip, useStore.getState().currentTimeMs);
  const thumbs = asset.thumbnails;
  const thumb =
    thumbs.length > 0
      ? thumbs[
          clamp(Math.round((srcMs / asset.durationMs) * (thumbs.length - 1)), 0, thumbs.length - 1)
        ]
      : undefined;

  const normPoint = (e: React.PointerEvent) => {
    const r = frameRef.current!.getBoundingClientRect();
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: React.PointerEvent, handle: CropHandle) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { nx, ny } = normPoint(e);
    useStore.getState().beginGesture();
    drag.current = { handle, startNx: nx, startNy: ny, orig: { ...crop } };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { nx, ny } = normPoint(e);
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
}

interface PreviewResize {
  clipId: string;
  origScale: number;
  /** Center of the clip's dest rect, normalized to the stage. */
  centerNx: number;
  centerNy: number;
  /** Pointer distance from the center when the drag started. */
  startDist: number;
}

/**
 * Output monitor + direct manipulation: dragging a clip in the preview moves
 * its transform position, the wheel over the preview scales the selected clip.
 * The hit-test and the selection outline reuse the compositor's dest-rect math,
 * expressed in % of the canvas so no pixel measuring is needed.
 */
export function PreviewCanvas() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<PreviewDrag | null>(null);
  const resize = useRef<PreviewResize | null>(null);
  const wheelGesture = useRef<number | null>(null);
  // Alignment guides drawn while dragging in the preview (normalized stage coords).
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });

  const project = useStore((s) => s.project);
  const assets = useStore((s) => s.assets);
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const selectedClip = useStore(getSelectedClip);
  const cropEditing = useStore((s) => s.cropEditing);

  const { width: outW, height: outH } = outputDimensions(project.aspectRatio);

  // Whether a media clip visible right now points at a disconnected source:
  // the canvas would otherwise just render black with no explanation.
  const disconnectedNow = project.tracks.some(
    (tr) =>
      tr.kind === 'video' &&
      !tr.hidden &&
      clipsAt(tr.clips, currentTimeMs).some(
        (c) => !isGeneratedClip(c) && assets[c.assetId]?.disconnected,
      ),
  );

  // Crop mode only makes sense for a media clip whose source we can show.
  const cropAsset = selectedClip && !isGeneratedClip(selectedClip) ? assets[selectedClip.assetId] : undefined;
  const croppingClip = cropEditing && selectedClip && cropAsset ? selectedClip : null;

  useEffect(() => {
    const engine = new PlaybackEngine(canvasRef.current!);
    return () => engine.dispose();
  }, []);

  /** Bounding rect of a clip in output coordinates (null when unknown). */
  const rectOf = (clip: Clip): DestRect | null => {
    if (isTextClip(clip)) return textClipRect(clip, outW, outH);
    if (clip.kind === 'solid') return { dx: 0, dy: 0, dw: outW, dh: outH };
    const asset = assets[clip.assetId];
    // The dest rect only depends on the source aspect ratio, known from the probe.
    if (!asset?.width || !asset?.height) return null;
    return clipDestRect(clip, asset.width, asset.height, outW, outH, currentTimeMs);
  };

  /** Topmost visible clip under a normalized point at the current time. */
  const hitTest = (nx: number, ny: number): Clip | null => {
    const px = nx * outW;
    const py = ny * outH;
    for (const track of [...project.tracks].reverse()) {
      if (track.kind !== 'video' || track.hidden || (track.opacity ?? 1) <= 0) continue;
      const visible = clipsAt(track.clips, currentTimeMs);
      for (let i = visible.length - 1; i >= 0; i--) {
        const clip = visible[i]!;
        const r = rectOf(clip);
        if (r && px >= r.dx && px <= r.dx + r.dw && py >= r.dy && py <= r.dy + r.dh) {
          return clip;
        }
      }
    }
    return null;
  };

  const normPoint = (e: React.PointerEvent): { nx: number; ny: number } => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { nx: (e.clientX - rect.left) / rect.width, ny: (e.clientY - rect.top) / rect.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The crop overlay owns the pointer while it is up.
    if (croppingClip) return;
    const { nx, ny } = normPoint(e);
    const clip = hitTest(nx, ny);
    if (!clip) return;
    const state = useStore.getState();
    state.selectClip(clip.id);
    state.beginGesture();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const t = clip.transform ?? DEFAULT_TRANSFORM;
    drag.current = { clipId: clip.id, startNx: nx, startNy: ny, origX: t.x, origY: t.y, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { nx, ny } = normPoint(e);
    if (!d.moved && Math.abs(nx - d.startNx) < 0.004 && Math.abs(ny - d.startNy) < 0.004) return;
    d.moved = true;
    const state = useStore.getState();
    const clip = state.project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
    if (!clip) return;
    const tf = clip.transform ?? DEFAULT_TRANSFORM;
    let x = d.origX + (nx - d.startNx);
    let y = d.origY + (ny - d.startNy);

    // Smart guides: the transform x/y IS the clip's normalized center, so snap
    // it to the frame center and to the frame edges (via the clip's half-size).
    // Holding Shift disables the magnetism. Fuchsia lines mark each active snap.
    const rect = rectOf(clip);
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
    setGuides({ v: vLines, h: hLines });

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
    setGuides({ v: [], h: [] });
  };

  /** Corner handle drag: rescale the clip around its center. */
  const onHandleDown = (e: React.PointerEvent, rect: DestRect, clip: Clip) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state = useStore.getState();
    state.beginGesture();
    const { nx, ny } = normPoint(e);
    const centerNx = (rect.dx + rect.dw / 2) / outW;
    const centerNy = (rect.dy + rect.dh / 2) / outH;
    resize.current = {
      clipId: clip.id,
      origScale: (clip.transform ?? DEFAULT_TRANSFORM).scale,
      centerNx,
      centerNy,
      startDist: Math.max(0.01, Math.hypot(nx - centerNx, ny - centerNy)),
    };
  };

  const onHandleMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r) return;
    const { nx, ny } = normPoint(e);
    const dist = Math.hypot(nx - r.centerNx, ny - r.centerNy);
    let scale = Math.min(8, Math.max(0.05, (r.origScale * dist) / r.startDist));
    // Magnetism: snap to the natural "fit-to-frame" scale (1.0) unless Shift is held.
    if (!e.shiftKey && Math.abs(scale - 1) < 0.03) scale = 1;
    const state = useStore.getState();
    const clip = state.project.tracks.flatMap((t) => t.clips).find((c) => c.id === r.clipId);
    if (!clip) return;
    const tf = clip.transform ?? DEFAULT_TRANSFORM;
    state.updateClip(r.clipId, { transform: { ...tf, scale } });
  };

  const onHandleUp = () => {
    if (!resize.current) return;
    useStore.getState().endGesture();
    resize.current = null;
  };

  // Wheel over the preview scales the selected clip. Native listener: React's
  // onWheel is passive, and scaling must preventDefault to not scroll the page.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const state = useStore.getState();
      const clip = getSelectedClip(state);
      if (!clip || state.cropEditing) return;
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
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  // Selection outline: only when the selected clip is actually on screen now
  // (and not while the crop overlay covers the stage).
  const selectedRect =
    !croppingClip &&
    selectedClip &&
    currentTimeMs >= selectedClip.timelineStartMs &&
    currentTimeMs < clipEndMs(selectedClip) &&
    project.tracks.some(
      (tr) => tr.kind === 'video' && !tr.hidden && tr.clips.some((c) => c.id === selectedClip.id),
    )
      ? rectOf(selectedClip)
      : null;

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden bg-zinc-950 p-1"
      style={{ containerType: 'size' }}
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
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="h-full w-full rounded-lg shadow-lg shadow-black/50" />
        {disconnectedNow && !croppingClip && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-zinc-950/70 px-4 text-center">
            <PlugZap className="h-7 w-7 text-amber-300" />
            <p className="text-xs font-medium text-amber-100">{t('preview.disconnected')}</p>
          </div>
        )}
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
      </div>
    </div>
  );
}
