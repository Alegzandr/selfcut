import type { Project } from '../types';
import type { PerfSnapshot } from '../perf/probe';
import type { ExportVideoCodec } from './presets';

/**
 * Protocol between the export worker and the segment workers it fans out to.
 *
 * A segment worker renders a contiguous range of output frames and encodes it
 * into a standalone, self-contained MP4 held in memory. It knows nothing about
 * the destination file, the audio, or the other segments: it is a pure
 * frames-in, packets-out unit of work, which is what makes it safe to run four
 * of them at once.
 */

export interface SegmentRequest {
  type: 'segment';
  /** Position in the output, used to reassemble in order. */
  index: number;
  project: Project;
  files: Record<string, File>;
  /**
   * Cloned rather than transferred: an ImageBitmap is both, and every segment
   * worker needs its own copy of every still.
   */
  stills: Record<string, ImageBitmap>;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  /** Already resolved by the lead: the codec this browser can actually encode. */
  codec: ExportVideoCodec;
  /**
   * Whether to declare the cadence on the segment's own video track. Resolved
   * once by the lead and passed down rather than probed per worker: the
   * segments are spliced packet for packet, so they have to be encoded the same
   * way, and a worker that disagreed with its neighbours would corrupt the
   * stream rather than merely produce a bigger file.
   */
  declareFrameRate: boolean;
  /** First timeline ms of the whole render (a region's in point, else 0). */
  startMs: number;
  /** First output frame of this segment, counted from the start of the render. */
  firstFrame: number;
  /** How many frames this segment covers. */
  frameCount: number;
  /** Turn this worker's frame instrumentation on (off by default: it is not free). */
  measure?: boolean;
}

export type SegmentReply =
  /** The finished segment, as a complete MP4. Transferred, not copied. */
  | {
      type: 'segmentDone';
      index: number;
      buffer: ArrayBuffer;
      frames: number;
      /** This slice's own frame breakdown, when `measure` was set. */
      perf?: PerfSnapshot;
    }
  /** Frames finished so far, so the lead can report a smooth overall progress. */
  | { type: 'segmentProgress'; index: number; frames: number }
  /**
   * A snapshot of the frame this slice is on, for the preview monitor. Every
   * slice offers one; the lead forwards only the slice it is waiting to mux and
   * closes the rest (see `renderParallel`).
   */
  | { type: 'segmentPreview'; index: number; bitmap: ImageBitmap; timeMs: number }
  | { type: 'segmentFailed'; index: number; detail: string };
