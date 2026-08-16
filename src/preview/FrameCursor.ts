import { MediaAsset } from '../types';
import type { DrawableFrame } from '../media/stillImage';
import type { FrameMessage, PreviewWorkerRequest, PreviewWorkerResponse } from './frameProtocol';

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

function ensureWorker(): Worker {
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
  }
  return worker;
}

function send(message: PreviewWorkerRequest): void {
  ensureWorker().postMessage(message);
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

  constructor(
    asset: MediaAsset,
    /** Called whenever a new decoded frame becomes available (to trigger a redraw). */
    private onFrame?: () => void,
  ) {
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
