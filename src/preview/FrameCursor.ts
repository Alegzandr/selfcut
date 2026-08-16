import { MediaAsset } from '../types';
import type { DrawableFrame } from '../media/stillImage';
import type { FrameMessage, PreviewWorkerRequest, PreviewWorkerResponse } from './frameProtocol';
import { reportCaughtError } from '../app/globalErrors';

/**
 * Main-thread proxy of one decode cursor living in the preview frame worker.
 * Keeps the old FrameCursor surface (request / sample / dispose) so the
 * playback engine is agnostic of where decoding happens, but the demuxer and
 * the WebCodecs decoder now run off the main thread: the proxy only ever
 * holds the latest transferred VideoFrame.
 */

let worker: Worker | null = null;
/** Live proxies by cursor id, to route incoming frames. */
const proxies = new Map<string, FrameCursor>();

/**
 * How many decode cursors are alive right now.
 *
 * Exists for the end-to-end test that this number stays bounded while the
 * playhead crosses a long timeline: the count is the whole point of the pool
 * (see cursorPool.ts), each cursor being a configured decoder in the worker,
 * and nothing else about the preview makes it observable from outside.
 */
export function liveCursorCount(): number {
  return proxies.size;
}

/**
 * Restarts attempted before the preview gives up on decoding.
 *
 * A worker dies from a bad frame, a driver reset, or an out-of-memory kill.
 * Before this, none of that was observed at all: only `onmessage` was
 * installed, so a dead worker meant the preview simply stopped producing
 * pictures - forever, silently, with the rAF loop still running and still
 * posting requests into a void.
 *
 * Bounded, because a worker that dies on every boot must not become an
 * infinite respawn loop eating the machine.
 */
const MAX_WORKER_RESTARTS = 3;
let workerRestarts = 0;
/** True once restarting has been given up on, so `send` stops trying. */
let decodingDead = false;

/** Whether the preview decoder has failed for good (drives the UI warning). */
export function isDecodingDead(): boolean {
  return decodingDead;
}

function ensureWorker(): Worker | null {
  if (decodingDead) return null;
  if (!worker) {
    worker = new Worker(new URL('./frameWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PreviewWorkerResponse>) => {
      const msg = event.data;
      const proxy = proxies.get(msg.cursorId);
      // A frame for a cursor disposed while the message was in flight must
      // still be closed, or its GPU memory lingers until GC.
      if (proxy) proxy.receive(msg);
      else msg.frame.close();
    };
    // An uncaught throw inside the worker. Without this handler the exception
    // is swallowed by the worker's own scope and nothing on this side ever
    // learns the decoder stopped.
    worker.onerror = (event) => {
      event.preventDefault?.();
      restartWorker(event instanceof ErrorEvent ? (event.message ?? 'worker error') : 'worker error');
    };
    // A message that could not be deserialized: rarer, but it means this
    // worker's protocol and ours have diverged, which no retry will fix on its
    // own - restarting at least reloads the module.
    worker.onmessageerror = () => {
      restartWorker('undeserializable message from the frame worker');
    };
  }
  return worker;
}

/**
 * Rebuild the worker and re-open every live cursor on it.
 *
 * The proxies survive the worker: the playback engine holds them, keyed by clip,
 * and knows nothing about workers. So the recovery is invisible from above -
 * each cursor re-creates itself and re-asks for the frame it last wanted, and
 * the next rAF tick draws.
 */
function restartWorker(reason: string): void {
  if (decodingDead) return;
  const dead = worker;
  worker = null;
  try {
    dead?.terminate();
  } catch {
    /* already gone */
  }
  if (workerRestarts >= MAX_WORKER_RESTARTS) {
    decodingDead = true;
    reportCaughtError('preview.decoder', new Error(`${reason} (giving up after ${workerRestarts} restarts)`));
    return;
  }
  workerRestarts++;
  console.warn(`[preview] frame worker restarting (${workerRestarts}/${MAX_WORKER_RESTARTS}):`, reason);
  for (const proxy of proxies.values()) proxy.reopen();
}

function send(message: PreviewWorkerRequest): void {
  ensureWorker()?.postMessage(message);
}

/**
 * A transferred VideoFrame, drawable like a mediabunny VideoSample.
 * `toVideoFrame` drops the container's rotation, so the rotation-aware draw
 * of mediabunny's VideoSample is reproduced here (source rect mapped back
 * onto the pre-rotation image, canvas rotated around the destination center).
 */
class RemoteFrame implements DrawableFrame {
  constructor(private msg: FrameMessage) {}

  get displayWidth(): number {
    return this.msg.displayWidth;
  }

  get displayHeight(): number {
    return this.msg.displayHeight;
  }

  /** Container rotation, read by the GPU path to decide it cannot upload directly. */
  get rotation(): number {
    return this.msg.rotation;
  }

  /** The decoder's own colour description, for the grade's luma matrix and transfer. */
  get colorSpace(): VideoColorSpace {
    return this.msg.frame.colorSpace;
  }

  /** Pixel format, so a 10-bit source can be uploaded at more than 8 bits. */
  get format(): string | null {
    return this.msg.frame.format;
  }

  /**
   * The decoded frame itself, for a direct GPU upload with no intermediate
   * canvas. Callers must honour `rotation`: this surface is the stored image,
   * before the container's rotation is applied (only `draw` applies it).
   */
  toCanvasImageSource(): VideoFrame {
    return this.msg.frame;
  }

  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    const { frame, rotation, squarePixelWidth, squarePixelHeight } = this.msg;
    if (rotation === 0) {
      ctx.drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }
    // The caller's source rect refers to the rotated image; map it back onto
    // the stored (pre-rotation) frame.
    if (rotation === 90) {
      [sx, sy, sw, sh] = [sy, squarePixelHeight - sx - sw, sh, sw];
    } else if (rotation === 180) {
      [sx, sy] = [squarePixelWidth - sx - sw, squarePixelHeight - sy - sh];
    } else if (rotation === 270) {
      [sx, sy, sw, sh] = [squarePixelWidth - sy - sh, sx, sh, sw];
    }
    ctx.save();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    // Scale to compensate for aspect ratio changes when rotated.
    const aspectRatioChange = rotation % 180 === 0 ? 1 : dw / dh;
    ctx.scale(1 / aspectRatioChange, aspectRatioChange);
    ctx.drawImage(frame, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  close(): void {
    this.msg.frame.close();
  }
}

let nextCursorId = 0;

export class FrameCursor {
  private id = `cursor-${nextCursorId++}`;
  private current: RemoteFrame | null = null;
  private disposed = false;
  /** Last requested time, to skip re-posting the identical paused request every rAF. */
  private lastSentSec = NaN;

  /** Everything needed to re-open this cursor on a restarted worker. */
  private readonly open: { assetId: string; file: File };

  constructor(
    asset: MediaAsset,
    /** Called whenever a new decoded frame becomes available (to trigger a redraw). */
    private onFrame?: () => void,
  ) {
    this.open = { assetId: asset.id, file: asset.file };
    proxies.set(this.id, this);
    send({ type: 'create', cursorId: this.id, assetId: asset.id, file: asset.file });
  }

  request(sourceSec: number, sequential: boolean): void {
    if (this.disposed) return;
    // Paused on the same time with a frame already shown: nothing to ask for.
    if (!sequential && this.current && sourceSec === this.lastSentSec) return;
    this.lastSentSec = sourceSec;
    send({ type: 'request', cursorId: this.id, sourceSec, sequential });
  }

  /**
   * Decode the first frame of a clip the playhead has not reached yet.
   *
   * Asked for sequentially, so the worker leaves its sample iterator open and
   * parked on that frame: when the playhead does arrive, the picture is already
   * there and the following frames come from an iterator that never had to seek.
   *
   * A no-op once anything has been requested on this cursor - re-asking every
   * tick would keep the worker decoding a frame nobody is showing yet, and would
   * fight the requests of the clip that is actually on screen.
   */
  prewarm(sourceSec: number): void {
    if (this.disposed || Number.isFinite(this.lastSentSec)) return;
    this.request(sourceSec, true);
  }

  /**
   * Re-open on a freshly started worker after a crash. The last shown frame is
   * kept on screen until a new one arrives, so the recovery does not flash
   * black; the last requested time is re-asked for so one does.
   */
  reopen(): void {
    if (this.disposed) return;
    send({ type: 'create', cursorId: this.id, assetId: this.open.assetId, file: this.open.file });
    if (Number.isFinite(this.lastSentSec)) {
      send({ type: 'request', cursorId: this.id, sourceSec: this.lastSentSec, sequential: false });
    }
  }

  /** Routed by the shared worker message handler; not part of the public surface. */
  receive(msg: FrameMessage): void {
    if (this.disposed) {
      msg.frame.close();
      return;
    }
    this.current?.close();
    this.current = new RemoteFrame(msg);
    this.onFrame?.();
  }

  get sample(): DrawableFrame | null {
    return this.current;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    proxies.delete(this.id);
    send({ type: 'dispose', cursorId: this.id });
    this.current?.close();
    this.current = null;
  }
}
