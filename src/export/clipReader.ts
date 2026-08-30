import type { VideoSampleSink, VideoSample } from 'mediabunny';
import { Clip } from '../types';
import { FRAME_MATCH_EPSILON_SEC, advancesToNextFrame } from '../media/frameMatch';
import { isHighBitDepth, transferKindFor } from '../media/frameSource';
import type { DrawableFrame } from '../media/stillImage';

/**
 * Two consecutive source frames cross-faded into one, so slow motion in the
 * render is the same continuous picture the preview showed instead of a
 * sequence of held frames.
 *
 * The pair is blended through each sample's own `draw`, which applies the
 * container rotation on the way in - so the canvas is already in display
 * orientation and reports no rotation of its own. That also makes it a direct
 * GPU upload for the grade (see `frameTexSource`), where a rotated sample would
 * have forced a copy.
 *
 * Built lazily: a frame can be superseded before anything draws it.
 */
class BlendedSample implements DrawableFrame {
  private canvas: OffscreenCanvas | null = null;
  private failed = false;

  constructor(
    private readonly a: VideoSample,
    private readonly b: VideoSample,
    private readonly mix: number,
  ) {}

  get displayWidth(): number {
    return this.a.displayWidth;
  }

  get displayHeight(): number {
    return this.a.displayHeight;
  }

  /** Blended in display orientation, so there is no rotation left to apply. */
  get rotation(): number {
    return 0;
  }

  /** An 8-bit sRGB canvas by now: the source's description no longer applies. */
  get colorSpace(): null {
    return null;
  }

  get format(): null {
    return null;
  }

  private surface(): OffscreenCanvas | null {
    if (this.canvas || this.failed) return this.canvas;
    const w = this.a.displayWidth;
    const h = this.a.displayHeight;
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        this.failed = true;
        return null;
      }
      this.a.draw(ctx, 0, 0, w, h, 0, 0, w, h);
      ctx.globalAlpha = this.mix;
      this.b.draw(ctx, 0, 0, w, h, 0, 0, w, h);
      ctx.globalAlpha = 1;
      this.canvas = canvas;
      return canvas;
    } catch {
      // Refused allocation: fall back to the first frame of the pair rather
      // than failing the render over a smoothing pass.
      this.failed = true;
      return null;
    }
  }

  toCanvasImageSource(): OffscreenCanvas | undefined {
    return this.surface() ?? undefined;
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
    const canvas = this.surface();
    if (canvas) ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    else this.a.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

/** Whether a pair can be blended without wrecking a high-bit-depth grade. */
function blendable(sample: VideoSample): boolean {
  const s = sample as unknown as { format?: string | null; colorSpace?: { transfer?: string | null } | null };
  return !isHighBitDepth(s.format, transferKindFor(s.colorSpace?.transfer));
}

/**
 * Sequential frame reader for one clip.
 *
 * An export walks a clip's source time strictly forward, so frames come from a
 * `samples()` async iterator: every packet is decoded exactly once and the
 * decoder stays configured for the whole clip. `getSample()` cannot do that -
 * it spins up a fresh `VideoDecoder` and re-decodes from the preceding key
 * frame on every call, so a 2 s GOP means decoding up to 60 frames to obtain
 * one. That is the same trap `FrameCursor` documents on the preview side, and
 * it dominated render time here.
 */
export class ClipReader {
  private sink: VideoSampleSink | null = null;
  private opened = false;
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private exhausted = false;
  private current: VideoSample | null = null;
  private lookahead: VideoSample | null = null;
  private lastSec = 0;

  constructor(
    private readonly clip: Clip,
    private readonly openSink: (clip: Clip) => Promise<VideoSampleSink | null>,
  ) {}

  /**
   * The picture to display at `sourceSec`, or null if nothing decodes.
   *
   * With `blend`, the two frames bracketing the instant are cross-faded (see
   * `BlendedSample`); the caller sets it from `shouldBlendFrames`, so the
   * render and the preview agree on when smoothing applies.
   */
  async frameAt(sourceSec: number, blend = false): Promise<DrawableFrame | null> {
    if (!this.opened) {
      this.opened = true;
      this.sink = await this.openSink(this.clip);
    }
    if (!this.sink) return null;
    const target = Math.max(0, sourceSec);

    // Source time normally advances with output time, but a reversed or ramped
    // speed can jump: restart the iterator rather than decode the gap.
    if (this.iterator && (target < this.lastSec || target > this.lastSec + 1)) {
      await this.stopIterator();
    }
    if (!this.iterator) {
      this.iterator = this.sink.samples(target);
      this.exhausted = false;
    }

    // Advance while the next frame is the nearer one to the target; the last
    // frame reached is the one to paint at that instant. See `frameMatch` for
    // why nearest and not "the last frame starting at or before the target".
    while (!this.exhausted) {
      if (!this.lookahead) {
        const { value, done } = await this.iterator.next();
        if (done || !value) {
          this.exhausted = true;
          break;
        }
        // Take exclusive ownership: mediabunny's iterator can close a yielded
        // sample again from its own cleanup when iteration starts past the last
        // frame. Cloning is a refcount bump and makes that stray close() a no-op.
        this.lookahead = value.clone();
        value.close();
      }
      if (this.current) {
        // Blended, the pair has to BRACKET the instant, so the rule becomes a
        // floor: `current` must never sit after the target. Unblended it stays
        // the nearest-frame rule, which is what absorbs container tick rounding
        // when a single frame has to be chosen. Same split as the preview
        // worker, for the same reason.
        const advance = blend
          ? this.lookahead.timestamp <= target + FRAME_MATCH_EPSILON_SEC
          : advancesToNextFrame(this.current.timestamp, this.lookahead.timestamp, target);
        if (!advance) break;
      }
      this.current?.close();
      this.current = this.lookahead;
      this.lookahead = null;
    }

    this.lastSec = target;
    if (blend && this.current && this.lookahead && blendable(this.current)) {
      const from = this.current.timestamp;
      const span = this.lookahead.timestamp - from;
      // A non-positive span means the timestamps do not separate the two
      // frames: there is no weight to compute, so show the first alone.
      if (span > 0) {
        const mix = Math.min(1, Math.max(0, (target - from) / span));
        return new BlendedSample(this.current, this.lookahead, mix);
      }
    }
    // Past the last frame of the source, the clip holds on its final frame.
    return this.current;
  }

  /** Release the iterator and every frame it still holds. */
  async close(): Promise<void> {
    await this.stopIterator();
  }

  private async stopIterator(): Promise<void> {
    this.lookahead?.close();
    this.lookahead = null;
    // Dropped too: after a seek the pre-seek frame is no longer what plays at
    // the new time, so the first sample the restarted iterator yields wins.
    this.current?.close();
    this.current = null;
    const it = this.iterator;
    this.iterator = null;
    this.exhausted = false;
    if (it) {
      try {
        await it.return(undefined);
      } catch {
        // Iterator cleanup failures are non-fatal.
      }
    }
  }
}
