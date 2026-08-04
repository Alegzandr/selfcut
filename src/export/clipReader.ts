import type { VideoSampleSink, VideoSample } from 'mediabunny';
import { Clip } from '../types';

/**
 * Slack on the "does this source frame start at or before the target instant?"
 * comparison, in seconds.
 *
 * Output time is built in milliseconds (`startMs + i * 1000 / fps`), shifted by
 * the clip's `sourceInMs` and divided back to seconds, while a source timestamp
 * comes from an exact integer ratio (pts / timescale). The two land on the same
 * instant mathematically but not always in binary: at a matching rate - 120 fps
 * footage exported at 120 - a target can fall a few ulps *below* the frame it
 * should select, so that frame is skipped, the previous one repeats, and the
 * render loses roughly one frame in eight. The file is a true 120 fps file and
 * still looks less fluid than the source, which is exactly the complaint.
 *
 * 1 microsecond is the granularity WebCodecs itself stores timestamps at, so
 * two instants closer than this are the same instant by definition - and it is
 * four orders of magnitude below the shortest frame we ever export.
 */
export const FRAME_MATCH_EPSILON_SEC = 1e-6;

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

  /** The source frame to display at `sourceSec`, or null if nothing decodes. */
  async frameAt(sourceSec: number): Promise<VideoSample | null> {
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

    // Advance while the next frame still starts at or before the target; the
    // last one reached is the frame on screen at that instant.
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
      if (this.current && this.lookahead.timestamp > target + FRAME_MATCH_EPSILON_SEC) break;
      this.current?.close();
      this.current = this.lookahead;
      this.lookahead = null;
    }

    this.lastSec = target;
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
