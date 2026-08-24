/**
 * Message protocol between the preview frame worker and its main-thread
 * proxies. One logical "cursor" per timeline clip: the worker owns the
 * decoder, the main thread only ever sees transferred VideoFrames.
 */

/** Open a decode cursor for a clip of `assetId`, backed by `file`. */
export interface CreateCursorMessage {
  type: 'create';
  cursorId: string;
  assetId: string;
  file: File;
}

/** Ask for the frame at `sourceSec` (same semantics as FrameCursor.request). */
export interface RequestFrameMessage {
  type: 'request';
  cursorId: string;
  sourceSec: number;
  sequential: boolean;
}

export interface DisposeCursorMessage {
  type: 'dispose';
  cursorId: string;
}

export type PreviewWorkerRequest =
  | CreateCursorMessage
  | RequestFrameMessage
  | DisposeCursorMessage;

/**
 * A decoded frame, transferred (zero-copy) to the main thread. `toVideoFrame`
 * drops the container's rotation metadata, so the rotation and the pre/post
 * rotation dimensions ride along for the main-thread wrapper to re-apply.
 */
export interface FrameMessage {
  type: 'frame';
  cursorId: string;
  frame: VideoFrame;
  /** Container rotation in degrees (0 | 90 | 180 | 270). */
  rotation: number;
  /** Post-rotation display size (what the compositor lays out with). */
  displayWidth: number;
  displayHeight: number;
  /** Pre-rotation square-pixel size (what the source rect maps back onto). */
  squarePixelWidth: number;
  squarePixelHeight: number;
}

/**
 * A decode threw for this cursor.
 *
 * Distinct from "found nothing": a seek past the end simply yields no sample
 * and is silent. Reaching here means the DECODER failed, which most often
 * means the browser's media process died under it - and that leaves the worker
 * itself alive, holding decoders that will never produce another frame. Nothing
 * observed that before this message existed: the preview went black and stayed
 * black, with the rAF loop still posting requests into a void.
 */
export interface DecodeFailedMessage {
  type: 'decodeFailed';
  cursorId: string;
  /** The underlying failure, for the console line that explains the recovery. */
  detail: string;
}

export type PreviewWorkerResponse = FrameMessage | DecodeFailedMessage;
