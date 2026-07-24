import { CanvasSink } from 'mediabunny';
import { Clip, ClipMask, Keyframe, MaskMotion, MediaAsset } from '../types';
import { clipEndMs, timelineToSourceMs } from '../model';
import { getInput } from './mediaCache';

/**
 * Planar motion tracking — position, scale and rotation — run entirely locally
 * on the decoded frames (nothing leaves the browser, like everything else here).
 *
 * The method is a two-point tracker. Two small patches are tracked across the
 * frames by template matching; their midpoint gives the translation, the length
 * of the vector between them gives the scale, and its angle gives the rotation.
 * That turns three parameters into two ordinary translational trackers, which is
 * robust enough for the everyday case (a face or object drifting, zooming or
 * tilting) without the cost and fragility of a full affine solve.
 *
 * The maths lives in `trackFrames`, which is pure (grayscale frames in, motion
 * out) and unit tested; the decode wrapper below only feeds it frames.
 */

/** A single grayscale frame: `data[y*w+x]` is luma in 0..255. */
export interface GrayFrame {
  data: Float32Array;
  w: number;
  h: number;
}

export interface TrackedMotion {
  /** Per-frame values, relative to the first frame (identity there). */
  tx: number[];
  ty: number[];
  scale: number[];
  rotation: number[];
}

interface Pt {
  x: number;
  y: number;
}

function sampleGray(f: GrayFrame, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= f.w ? f.w - 1 : x;
  const cy = y < 0 ? 0 : y >= f.h ? f.h - 1 : y;
  return f.data[cy * f.w + cx]!;
}

/** Copy the `(2·half+1)²` patch centred on `(cx, cy)` (edge-clamped). */
export function extractPatch(f: GrayFrame, cx: number, cy: number, half: number): Float32Array {
  const size = 2 * half + 1;
  const out = new Float32Array(size * size);
  let k = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      out[k++] = sampleGray(f, cx + dx, cy + dy);
    }
  }
  return out;
}

/**
 * Best integer position of `ref` in `f` within `radius` of `(cx, cy)`, by lowest
 * sum-of-squared-difference. The search is recentred on the previous position
 * each frame, so it follows motion larger than the window one step at a time.
 */
export function searchPatch(
  f: GrayFrame,
  ref: Float32Array,
  half: number,
  cx: number,
  cy: number,
  radius: number,
): Pt {
  let best = Infinity;
  let bx = cx;
  let by = cy;
  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      const px = cx + ox;
      const py = cy + oy;
      let ssd = 0;
      let k = 0;
      for (let dy = -half; dy <= half && ssd < best; dy++) {
        const yy = py + dy;
        for (let dx = -half; dx <= half; dx++) {
          const d = sampleGray(f, px + dx, yy) - ref[k++]!;
          ssd += d * d;
        }
      }
      if (ssd < best) {
        best = ssd;
        bx = px;
        by = py;
      }
    }
  }
  return { x: bx, y: by };
}

/** Midpoint, vector length and angle (radians) of a point pair. */
function geometry(a: Pt, b: Pt): { cx: number; cy: number; len: number; ang: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, len: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) };
}

/** Wrap a degree delta into -180..180, so a rotation never jumps by a full turn. */
function wrapDeg(d: number): number {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/**
 * Track the two points across the frames and return the motion of the pair,
 * relative to the first frame. `tx`/`ty` are fractions of the frame size (so
 * they map straight onto a mask's motion channels); `scale` is a ratio; and
 * `rotation` is in degrees. Pure and deterministic.
 */
export function trackFrames(
  frames: GrayFrame[],
  p1: Pt,
  p2: Pt,
  opts: { half: number; radius: number },
): TrackedMotion {
  const out: TrackedMotion = { tx: [], ty: [], scale: [], rotation: [] };
  if (frames.length === 0) return out;
  const f0 = frames[0]!;
  const ref1 = extractPatch(f0, Math.round(p1.x), Math.round(p1.y), opts.half);
  const ref2 = extractPatch(f0, Math.round(p2.x), Math.round(p2.y), opts.half);
  const base = geometry(p1, p2);

  let a = { ...p1 };
  let b = { ...p2 };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (i > 0) {
      a = searchPatch(f, ref1, opts.half, Math.round(a.x), Math.round(a.y), opts.radius);
      b = searchPatch(f, ref2, opts.half, Math.round(b.x), Math.round(b.y), opts.radius);
    }
    const g = geometry(a, b);
    out.tx.push((g.cx - base.cx) / f.w);
    out.ty.push((g.cy - base.cy) / f.h);
    out.scale.push(base.len > 1e-3 ? g.len / base.len : 1);
    out.rotation.push(wrapDeg(((g.ang - base.ang) * 180) / Math.PI));
  }
  return out;
}

/** RGBA image data → a grayscale frame (BT.601 luma). */
function toGray(img: ImageData): GrayFrame {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
  }
  return { data: out, w: width, h: height };
}

/** Output-fraction bounding box of a mask (path bbox, or the rect/ellipse box). */
function maskBBox(mask: ClipMask): { cx: number; cy: number; w: number; h: number } {
  if (mask.shape === 'path' && mask.path && mask.path.length) {
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const p of mask.path) {
      if (p.x < minx) minx = p.x;
      if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y;
      if (p.y > maxy) maxy = p.y;
    }
    return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, w: maxx - minx, h: maxy - miny };
  }
  return { cx: mask.x, cy: mask.y, w: mask.w, h: mask.h };
}

export interface TrackOptions {
  /** Timeline ms of the reference frame (motion is the identity there). */
  fromMs: number;
  /** Frames per second to sample the clip at. */
  fps: number;
}

/**
 * Track a clip's footage under the given mask and return keyframed `motion` that
 * makes the mask follow the subject. Decodes frames from the reference time to
 * the clip end, tracks two points seeded from the mask's box, and writes one
 * keyframe per frame. Returns null when the clip has no decodable video.
 */
export async function trackMaskMotion(
  clip: Clip,
  asset: MediaAsset,
  mask: ClipMask,
  opts: TrackOptions,
  onProgress: (frac: number) => void,
  signal?: AbortSignal,
): Promise<MaskMotion | null> {
  const srcW = asset.width ?? 0;
  const srcH = asset.height ?? 0;
  if (!srcW || !srcH) return null;
  const track = await getInput(asset).getPrimaryVideoTrack();
  if (!track) return null;

  // Downscaled working resolution (source aspect kept) — enough texture to track,
  // cheap enough to decode and search a whole clip in seconds.
  const workW = Math.min(360, srcW);
  const workH = Math.max(2, Math.round((workW * srcH) / srcW));
  const sink = new CanvasSink(track, { width: workW, height: workH, fit: 'fill' });

  // Timeline sample times from the reference frame to the clip end → source secs.
  const endMs = clipEndMs(clip);
  const dt = 1000 / Math.max(1, opts.fps);
  const times: number[] = [];
  for (let t = opts.fromMs; t <= endMs + 1e-6; t += dt) times.push(t);
  if (times.length < 2) return null;
  const stamps = times.map((t) => timelineToSourceMs(clip, t) / 1000);

  const scratch = new OffscreenCanvas(workW, workH);
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!sctx) return null;

  const frames: GrayFrame[] = [];
  const localMs: number[] = [];
  let i = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(stamps)) {
    if (signal?.aborted) return null;
    if (wrapped) {
      sctx.clearRect(0, 0, workW, workH);
      sctx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, workW, workH);
      frames.push(toGray(sctx.getImageData(0, 0, workW, workH)));
      localMs.push(times[i]! - clip.timelineStartMs);
    }
    i++;
    onProgress(Math.min(1, i / stamps.length));
    // Yield so the decode loop never locks the UI for long.
    await Promise.resolve();
  }
  if (frames.length < 2) return null;

  // Seed two points across the mask box (horizontal pair), in working px.
  const bbox = maskBBox(mask);
  const cx = bbox.cx * workW;
  const cy = bbox.cy * workH;
  const off = Math.max(6, bbox.w * workW * 0.28);
  const half = Math.max(6, Math.round(workW * 0.03));
  const radius = Math.max(8, Math.round(workW * 0.045));
  const motion = trackFrames(frames, { x: cx - off, y: cy }, { x: cx + off, y: cy }, { half, radius });

  const chan = (values: number[]): Keyframe[] => values.map((value, k) => ({ t: localMs[k]!, value }));
  return {
    tx: chan(motion.tx),
    ty: chan(motion.ty),
    scale: chan(motion.scale),
    rotation: chan(motion.rotation),
  };
}
