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
  | { type: 'segmentFailed'; index: number; detail: string };
