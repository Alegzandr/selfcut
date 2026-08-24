import {
  ALL_FORMATS,
  BlobSource,
  Input,
  VideoSample,
  VideoSampleSink,
} from 'mediabunny';
import { advancesToNextFrame } from '../media/frameMatch';
import type { PreviewWorkerRequest, PreviewWorkerResponse } from './frameProtocol';

/**
 * Preview decode worker: owns every mediabunny Input/VideoSampleSink the
 * preview uses, so demuxing and decode scheduling never block the UI thread.
 * Each timeline clip gets one cursor (mirroring the old main-thread
 * FrameCursor); decoded frames travel back as transferred VideoFrames.
 */

function post(message: PreviewWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Identity of a File across structured clones (clones are never `===`). */
function fileKey(file: File): string {
  return `${file.name}#${file.size}#${file.lastModified}`;
}

interface AssetEntry {
  key: string;
  input: Input;
  refs: number;
}

/** One Input per asset, shared by all its cursors, refcounted for disposal. */
const assets = new Map<string, AssetEntry>();

function acquireInput(assetId: string, file: File): Input {
  const key = fileKey(file);
  let entry = assets.get(assetId);
  // A reconnected source keeps its asset id but points at a fresh file: the
  // stale demuxer must go, otherwise cursors keep decoding the old footage.
  if (entry && entry.key !== key) {
    if (entry.refs === 0) entry.input.dispose();
    entry = undefined;
  }
  if (!entry) {
    entry = { key, input: new Input({ formats: ALL_FORMATS, source: new BlobSource(file) }), refs: 0 };
    assets.set(assetId, entry);
  }
  entry.refs++;
  return entry.input;
}

function releaseInput(assetId: string, input: Input): void {
  const entry = assets.get(assetId);
  // The entry may already belong to a newer file: only the matching input's
  // refcount is ours to drop.
  if (!entry || entry.input !== input) {
    input.dispose();
    return;
  }
  entry.refs--;
  if (entry.refs <= 0) {
    entry.input.dispose();
    assets.delete(assetId);
  }
}

async function createSink(input: Input): Promise<VideoSampleSink | null> {
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return null;
  return new VideoSampleSink(track);
}

/**
 * Worker-side clone of the old main-thread FrameCursor: coalesced requests
 * (a decode in flight keeps only the latest asked time), sequential iterator
 * for playback vs random access for scrub. The only behavioral difference is
 * the output: instead of exposing the sample, each new frame is posted to the
 * main thread as a transferred VideoFrame.
 */
class WorkerCursor {
  private sinkPromise: Promise<VideoSampleSink | null>;
  private current: VideoSample | null = null;
  private busy = false;
  private pending: { sourceSec: number; sequential: boolean } | null = null;
  private disposed = false;

  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private iteratorDone = false;
  private lookahead: VideoSample | null = null;
  private lastSec = 0;

  constructor(
    private cursorId: string,
    private assetId: string,
    private input: Input,
  ) {
    this.sinkPromise = createSink(input);
  }

  request(sourceSec: number, sequential: boolean): void {
    if (!sequential && !this.busy && this.current && sourceSec === this.lastSec) return;
    if (this.busy) {
      this.pending = { sourceSec, sequential };
      return;
    }
    this.busy = true;
    void this.fetch(Math.max(0, sourceSec), sequential);
  }

  private emit(): void {
    if (!this.current) return;
    const frame = this.current.toVideoFrame();
    post(
      {
        type: 'frame',
        cursorId: this.cursorId,
        frame,
        rotation: this.current.rotation,
        displayWidth: this.current.displayWidth,
        displayHeight: this.current.displayHeight,
        squarePixelWidth: this.current.squarePixelWidth,
        squarePixelHeight: this.current.squarePixelHeight,
      },
      [frame],
    );
  }

  private async fetch(sourceSec: number, sequential: boolean): Promise<void> {
    try {
      const sink = await this.sinkPromise;
      if (sink && !this.disposed) {
        if (sequential) await this.fetchSequential(sink, sourceSec);
        else await this.fetchSeek(sink, sourceSec);
      }
    } catch (err) {
      // Reported, not swallowed. A decode that THROWS is not a decode that
      // finds nothing - a seek past the end yields no sample and never lands
      // here - so this is the decoder itself failing, and the usual cause takes
      // every decoder in this worker with it. Left silent, the cursor keeps its
      // last frame (or none at all) for the rest of the session while the main
      // thread waits for a picture that cannot come. See DecodeFailedMessage.
      if (!this.disposed) {
        post({
          type: 'decodeFailed',
          cursorId: this.cursorId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.busy = false;
      if (this.disposed) {
        this.releaseAll();
      } else if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.request(next.sourceSec, next.sequential);
      }
    }
  }

  private async fetchSeek(sink: VideoSampleSink, sourceSec: number): Promise<void> {
    await this.stopIterator();
    const sample = await sink.getSample(sourceSec);
    if (sample) {
      this.current?.close();
      this.current = sample;
      this.emit();
    }
    this.lastSec = sourceSec;
  }

  private async fetchSequential(sink: VideoSampleSink, sourceSec: number): Promise<void> {
    // A backward jump or a large forward jump is a seek: restart the iterator.
    if (this.iterator && (sourceSec < this.lastSec || sourceSec > this.lastSec + 1)) {
      await this.stopIterator();
    }
    if (!this.iterator) {
      this.iterator = sink.samples(sourceSec);
      this.iteratorDone = false;
    }
    // Advance while the next frame is the nearer one to sourceSec; the last one
    // reached is shown. Same rule as the export reader, from the same module:
    // the preview is where the cadence of a render gets judged, so both paths
    // have to land on the same frame.
    while (!this.iteratorDone) {
      if (!this.lookahead) {
        const { value, done } = await this.iterator.next();
        if (done || !value) {
          this.iteratorDone = true;
          break;
        }
        // Take exclusive ownership: mediabunny's iterator can close a yielded
        // sample again from closeSamples() when iteration starts past the last
        // frame (lastSample is queued without being nulled). Cloning is cheap
        // (VideoFrame refcount) and makes that stray close() a no-op.
        this.lookahead = value.clone();
        value.close();
      }
      if (this.current && !advancesToNextFrame(this.current.timestamp, this.lookahead.timestamp, sourceSec)) {
        break;
      }
      this.current?.close();
      this.current = this.lookahead;
      this.lookahead = null;
      this.emit();
    }
    this.lastSec = sourceSec;
  }

  private async stopIterator(): Promise<void> {
    this.lookahead?.close();
    this.lookahead = null;
    const it = this.iterator;
    this.iterator = null;
    this.iteratorDone = false;
    if (it) {
      try {
        await it.return(undefined);
      } catch {
        // Iterator cleanup failures are non-fatal.
      }
    }
  }

  private releaseAll(): void {
    void this.stopIterator();
    this.current?.close();
    this.current = null;
    releaseInput(this.assetId, this.input);
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    // If a fetch is in flight, it releases everything on completion.
    if (!this.busy) this.releaseAll();
  }
}

const cursors = new Map<string, WorkerCursor>();

self.onmessage = (event: MessageEvent<PreviewWorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'create') {
    cursors.get(msg.cursorId)?.dispose();
    cursors.set(msg.cursorId, new WorkerCursor(msg.cursorId, msg.assetId, acquireInput(msg.assetId, msg.file)));
  } else if (msg.type === 'request') {
    cursors.get(msg.cursorId)?.request(msg.sourceSec, msg.sequential);
  } else if (msg.type === 'dispose') {
    cursors.get(msg.cursorId)?.dispose();
    cursors.delete(msg.cursorId);
  }
};
