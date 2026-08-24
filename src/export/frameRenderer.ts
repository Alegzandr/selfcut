import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import type { Clip, Project } from '../types';
import { isTextClip, timelineToSourceMs } from '../model';
import { drawClip, forEachVisibleVideoClip, invalidateResampling } from '../preview/compositor';
import { syncLuts } from '../preview/colorPass';
import { loadFonts } from '../lib/fonts';
import { StillFrame, type DrawableFrame } from '../media/stillImage';
import { FONT_STALL_MS, TEARDOWN_STALL_MS, withDeadline } from './stallGuard';
import { ClipReader } from './clipReader';
import { endSpan, span } from '../perf/probe';

/**
 * Painting one output frame of a render.
 *
 * Extracted from the export worker so that the serial render and each worker of
 * a parallel render composite through the SAME code. That is not tidiness: a
 * parallel export is only trustworthy if segment 3 rendered by worker B is
 * byte-identical to what worker A would have rendered, and the surest way to
 * guarantee that is for there to be one implementation.
 *
 * The renderer owns everything that is expensive to build - the canvas, the
 * demuxer inputs, one decode reader per clip - and nothing that decides where
 * the frames go.
 */

/** One clip to composite into the current frame, with its decoded source frame. */
interface FrameLayer {
  clip: Clip;
  xfadeInMs: number;
  alphaMul: number;
  sample: DrawableFrame | null;
}

export interface FrameRendererOptions {
  project: Project;
  /** assetId → source file, for every asset the project references. */
  files: Record<string, File>;
  /** assetId → pre-rasterized still (SVG needs the DOM, so the main thread does it). */
  stills: Record<string, ImageBitmap>;
  width: number;
  height: number;
  /** Output frame rate; frame `i` renders timeline time `startMs + i/fps`. */
  fps: number;
  /** First timeline ms of the render (a region's in point, else 0). */
  startMs: number;
}

export class FrameRenderer {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly stills: Map<string, StillFrame>;
  private readonly inputs = new Map<string, Input>();
  /**
   * One reader per clip, created on first use and released as soon as the clip
   * is behind the render head.
   *
   * Keeping them all for the whole render is what a first pass does, and it
   * scales with the length of the cut rather than with how much of it is on
   * screen: each reader owns a configured VideoDecoder and holds one or two
   * decoded samples (~12 MB apiece at 4K), so a fifty-clip 4K timeline had
   * fifty decoders and hundreds of megabytes of frames live at the last frame
   * of the render, competing for the handful of decoders a browser will run in
   * parallel. The render walks output time strictly forward and no clip is
   * visible twice, so a reader missing from the current frame's layers can
   * only be one whose clip has ended: dropping it is exact, not a heuristic.
   */
  private readonly readers = new Map<string, ClipReader>();
  /** Reused across frames: the layer list was garbage on every one of them. */
  private readonly layers: FrameLayer[] = [];

  constructor(private readonly opts: FrameRendererOptions) {
    // Register the project's LUTs on this thread's colour pass, exactly as the
    // preview does, so the export grades every clip identically to what was seen.
    syncLuts(opts.project.luts);
    this.stills = new Map(
      Object.entries(opts.stills).map(([assetId, bitmap]) => [assetId, new StillFrame(bitmap)]),
    );
    this.canvas = new OffscreenCanvas(opts.width, opts.height);
    // No alpha channel: every frame starts as an opaque black fill, so the canvas
    // never needs one. Dropping it skips premultiplied blending on each drawImage
    // and lets the capture go straight to YUV - measurable at 4K over thousands
    // of frames.
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    // Resampling quality is decided per draw by the compositor: 'high' whenever a
    // clip is actually being scaled (fit, crop, zoom, a 4K source into a 1080p
    // export), off for a 1:1 blit, which is what a full-frame clip exported at its
    // own resolution does on every one of thousands of frames.
    invalidateResampling(this.ctx);
  }

  /**
   * A worker inherits nothing from `document.fonts`: without this the canvas
   * would silently fall back to the default face and the export would not match
   * the preview. Awaited up front, since wrapping measures against the real
   * metrics from the very first frame.
   */
  async ready(): Promise<void> {
    const fonts = loadFonts(
      this.opts.project.tracks.flatMap((track) =>
        track.clips.filter(isTextClip).map((clip) => clip.text.font),
      ),
    );
    // Deadlined, and then swallowed: this await sits before the first frame of
    // the render, so a face that never arrives holds the whole export at zero
    // with nothing on the bar to say why. A missing face is cosmetic - the
    // canvas falls back through `fontStack` - and an export that never starts
    // is not. See FONT_STALL_MS.
    await withDeadline(fonts, FONT_STALL_MS, 'font loading').catch((err: unknown) => {
      console.warn('[export] fonts did not load in time, rendering with fallbacks:', err);
    });
  }

  private getInput(assetId: string): Input | null {
    let input = this.inputs.get(assetId) ?? null;
    if (!input) {
      const file = this.opts.files[assetId];
      if (!file) return null;
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
      this.inputs.set(assetId, input);
    }
    return input;
  }

  private openSink = async (clip: Clip): Promise<VideoSampleSink | null> => {
    const input = this.getInput(clip.assetId);
    if (!input) return null;
    try {
      const track = await input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) return new VideoSampleSink(track);
    } catch {
      // Unreadable source (e.g. a still that failed to rasterize): the clip
      // renders nothing rather than killing the whole export.
    }
    return null;
  };

  private reader(clip: Clip): ClipReader {
    let reader = this.readers.get(clip.id);
    if (!reader) {
      reader = new ClipReader(clip, this.openSink);
      this.readers.set(clip.id, reader);
    }
    return reader;
  }

  /**
   * Decode and composite output frame `index` onto the canvas.
   *
   * Returns once the canvas holds the finished frame. The caller decides what to
   * do with it - hand it to an encoder, read it back, ignore it.
   */
  async renderFrame(index: number): Promise<void> {
    const { project, width, height, fps, startMs } = this.opts;
    // Output time index/fps maps to timeline time startMs + index/fps: exporting
    // a region shifts what we read, never where the frame lands in the file.
    const tMs = startMs + (index * 1000) / fps;

    // Bottom-up over tracks so the timeline's top lane paints last, then
    // earliest-first within a track: during a crossfade the incoming clip
    // composites over the outgoing one with rising alpha (same as preview).
    const layers = this.layers;
    layers.length = 0;
    for (let t = project.tracks.length - 1; t >= 0; t--) {
      const track = project.tracks[t]!;
      const alphaMul = track.opacity ?? 1;
      if (alphaMul <= 0) continue;
      forEachVisibleVideoClip(track, tMs, (clip, xfadeInMs) => {
        layers.push({ clip, xfadeInMs, alphaMul, sample: null });
      });
    }

    // Decode every visible media clip concurrently: the readers are
    // independent, so N stacked tracks cost one decode wait instead of N.
    const decodeStarted = span();
    await Promise.all(
      layers.map(async (layer) => {
        const { clip } = layer;
        if (clip.kind !== 'media') return;
        const still = this.stills.get(clip.assetId);
        if (still) {
          // A still is the same frame at every output time - nothing to decode.
          layer.sample = still;
          return;
        }
        layer.sample = await this.reader(clip).frameAt(timelineToSourceMs(clip, tMs) / 1000);
      }),
    );
    endSpan('decode', decodeStarted);

    const compositeStarted = span();
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    for (const { clip, xfadeInMs, alphaMul, sample } of layers) {
      drawClip(this.ctx, clip, width, height, tMs, alphaMul, xfadeInMs, sample);
    }
    endSpan('composite', compositeStarted);
  }

  /**
   * Release the decoders of clips the render head has moved past.
   *
   * Called after the frame has been captured, never before: the layers hold
   * frames these readers own, and it is the capture that copies them out.
   */
  async releaseFinishedReaders(): Promise<void> {
    const visible = new Set(this.layers.map((layer) => layer.clip.id));
    for (const [clipId, reader] of [...this.readers]) {
      if (visible.has(clipId)) continue;
      this.readers.delete(clipId);
      await closeReader(reader);
    }
  }

  async dispose(): Promise<void> {
    for (const reader of this.readers.values()) await closeReader(reader);
    this.readers.clear();
    for (const still of this.stills.values()) {
      try {
        still.close();
      } catch {
        /* already closed */
      }
    }
    this.stills.clear();
    for (const input of this.inputs.values()) input.dispose();
    this.inputs.clear();
  }
}

/**
 * Close one reader, and give up on it rather than wait for ever.
 *
 * Closing a reader runs through its `VideoDecoder`, so it inherits every way a
 * decoder can stop answering - and this is called from INSIDE the frame loop,
 * once per frame, not only on the way out. Left un-deadlined it is a place a
 * render can stop with nothing counting: no error, no console line, the bar
 * simply frozen mid-loop while the app stays responsive. Every other await in
 * that loop already carries a deadline; this one was the exception.
 *
 * Swallowed either way. The reader has already been dropped from the map by the
 * time this runs, so the render is done with it whether it closes or not - and
 * a decoder abandoned here is freed when the worker ends, which for the frame
 * loop's caller is soon.
 */
async function closeReader(reader: ClipReader): Promise<void> {
  try {
    await withDeadline(reader.close(), TEARDOWN_STALL_MS, 'reader close');
  } catch {
    /* already released, or stopped answering - neither is the render's problem */
  }
}
