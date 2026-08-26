import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '../types';
import { SEGMENT_MS, type AudioSegment } from '../media/audioSegments';
import { MixScheduler, type SegmentLookup } from './audioMix';

/**
 * Audio is decoded in 30 s pieces, so a clip is played by a row of buffer
 * sources rather than by one, and the row is handed to the context as the
 * playhead approaches it. Every bug that costs a user their sound lives in the
 * arithmetic below: an offset read from the wrong end of a piece, a piece
 * scheduled twice because two windows overlapped, a piece that arrived late and
 * was never picked up, or a second gain chain built for a clip that already had
 * one (which doubles its volume at a segment boundary).
 *
 * The context is faked rather than mocked out: what is asserted is exactly the
 * `start(when, offset, duration)` triple the browser would be given.
 */

const SR = 48_000;

class FakeParam {
  readonly events: [string, number, number][] = [];
  value = 1;
  setValueAtTime(value: number, time: number): this {
    this.events.push(['set', value, time]);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push(['ramp', value, time]);
    return this;
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = 0;
  connect(node: FakeNode): FakeNode {
    this.outputs.push(node);
    return node;
  }
  disconnect(): void {
    this.disconnected++;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
}

class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = { value: 1 };
  started: { when: number; offset: number; duration: number } | null = null;
  onended: (() => void) | null = null;
  start(when: number, offset: number, duration: number): void {
    this.started = { when, offset, duration };
  }
  stop(): void {}
}

class FakeCtx {
  currentTime = 0;
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createStereoPanner(): FakeNode {
    return new FakeNode();
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

/** A decoded piece of `SEGMENT_MS`, or of an explicit length for the last one. */
function segment(index: number, lengthMs = SEGMENT_MS): AudioSegment {
  return {
    index,
    startMs: index * SEGMENT_MS,
    buffer: {
      length: Math.round((lengthMs / 1000) * SR),
      sampleRate: SR,
      numberOfChannels: 2,
    } as AudioBuffer,
  };
}

/** A lookup over a fixed set of pieces, filtered the way the real cache is. */
function lookupOf(...segments: AudioSegment[]): SegmentLookup {
  return (_assetId, _trackIndex, fromMs, toMs) =>
    segments.filter(
      (s) => s.startMs < toMs && s.startMs + (s.buffer.length / s.buffer.sampleRate) * 1000 > fromMs,
    );
}

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    kind: 'media',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  } as Clip;
}

function project(clips: Clip[], over: Partial<Track> = {}): Project {
  const track: Track = { id: 't1', kind: 'audio', clips, ...over };
  return { id: 'p1', aspectRatio: '16:9', fps: 30, tracks: [track], markers: [] } as Project;
}

/** Scheduler anchored so timeline `anchorMs` is heard at context time 0. */
function scheduler(ctx: FakeCtx, lookup: SegmentLookup, anchorMs = 0, rate = 1): MixScheduler {
  return new MixScheduler(
    ctx as unknown as BaseAudioContext,
    new FakeNode() as unknown as AudioNode,
    lookup,
    anchorMs,
    0,
    rate,
  );
}

describe('MixScheduler', () => {
  it('plays a clip from one piece at the offset its in point falls on', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0)));
    mix.extend(project([clip({ sourceInMs: 1000, sourceOutMs: 4000 })]), 0, 10_000);

    expect(ctx.sources).toHaveLength(1);
    // Offset is measured inside the PIECE, not from the source's zero: reading
    // it from the wrong end is the bug that plays the top of a take instead of
    // the middle of it.
    expect(ctx.sources[0]!.started).toEqual({ when: 0, offset: 1, duration: 3 });
  });

  it('reads a piece from the source timestamp it is anchored to', () => {
    const ctx = new FakeCtx();
    // A clip reading the second minute of a recording: the piece begins at
    // 60 s of SOURCE time, so an in point of 65 s is 5 s into it.
    const index = 60_000 / SEGMENT_MS;
    const mix = scheduler(ctx, lookupOf(segment(index)));
    mix.extend(project([clip({ sourceInMs: 65_000, sourceOutMs: 70_000 })]), 0, 10_000);

    expect(ctx.sources[0]!.started).toEqual({ when: 0, offset: 5, duration: 5 });
  });

  it('joins two pieces edge to edge across a boundary', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0), segment(1)));
    // Straddles the 30 s boundary: 25 s in the first piece, 10 s in the second.
    mix.extend(project([clip({ sourceInMs: 25_000, sourceOutMs: 40_000 })]), 0, 60_000);

    expect(ctx.sources).toHaveLength(2);
    const [first, second] = ctx.sources as [FakeSource, FakeSource];
    expect(first.started).toEqual({ when: 0, offset: 25, duration: 5 });
    // The second starts exactly where the first ends, in both clocks: a gap or
    // an overlap here is an audible click every 30 s.
    expect(second.started!.when).toBeCloseTo(first.started!.when + first.started!.duration, 9);
    expect(second.started).toEqual({ when: 5, offset: 0, duration: 10 });
  });

  it('never schedules the same piece twice, however the windows overlap', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0), segment(1)));
    const p = project([clip({ sourceInMs: 0, sourceOutMs: 40_000 })]);
    // What the preview really does: extend on every tick, from the playhead.
    mix.extend(p, 0, 20_000);
    mix.extend(p, 5_000, 25_000);
    mix.extend(p, 12_000, 32_000);

    expect(ctx.sources).toHaveLength(2);
  });

  it('picks up a piece that finished decoding after its window', () => {
    const ctx = new FakeCtx();
    const first = segment(0);
    let available = [first];
    const mix = scheduler(ctx, (_a, _t, from, to) =>
      available.filter(
        (s) => s.startMs < to && s.startMs + (s.buffer.length / s.buffer.sampleRate) * 1000 > from,
      ),
    );
    const p = project([clip({ sourceInMs: 0, sourceOutMs: 40_000 })]);
    mix.extend(p, 0, 40_000);
    expect(ctx.sources).toHaveLength(1);

    // The second piece lands late. Re-running the same window is what makes it
    // audible - without it the clip goes silent at 30 s for good.
    available = [first, segment(1)];
    ctx.currentTime = 10;
    mix.extend(p, 10_000, 50_000);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]!.started).toEqual({ when: 30, offset: 0, duration: 10 });
  });

  it('enters a piece where the transport already is, rather than replaying it', () => {
    const ctx = new FakeCtx();
    // Seeked 2 s into a clip that starts at the timeline's zero: the schedule
    // is anchored at the new position, exactly as `restartAt` anchors it.
    const mix = scheduler(ctx, lookupOf(segment(0)), 2000);
    mix.extend(project([clip({ sourceOutMs: 5000 })]), 2000, 12_000);

    expect(ctx.sources[0]!.started).toEqual({ when: 0, offset: 2, duration: 3 });
  });

  it('skips a piece whose moment has entirely passed', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 8;
    const mix = scheduler(ctx, lookupOf(segment(0)));
    // Anchored at 0, so this clip's 5 s were heard between context time 0 and 5.
    mix.extend(project([clip({ sourceOutMs: 5000 })]), 0, 20_000);

    expect(ctx.sources).toHaveLength(0);
  });

  it('scales the catch-up by speed and shuttle rate', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 1;
    // Playing at 2x, on a clip that is itself at 2x: one second of context time
    // is four seconds of source.
    const mix = scheduler(ctx, lookupOf(segment(0)), 0, 2);
    mix.extend(project([clip({ sourceInMs: 0, sourceOutMs: 20_000, speed: 2 })]), 0, 20_000);

    const started = ctx.sources[0]!.started!;
    expect(started.when).toBe(1);
    expect(started.offset).toBeCloseTo(4, 9);
    expect(started.duration).toBeCloseTo(16, 9);
    expect(ctx.sources[0]!.playbackRate.value).toBe(4);
  });

  it('builds one gain chain per clip, whatever the number of pieces', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0), segment(1), segment(2)));
    const p = project([clip({ sourceInMs: 0, sourceOutMs: 80_000, volume: 0.5 })]);
    mix.extend(p, 0, 30_000);
    mix.extend(p, 30_000, 90_000);

    // A second chain would put the clip's volume, fades and effects on the
    // signal twice from the first boundary on.
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.gains[0]!.gain.events[0]).toEqual(['set', 0.5, 0]);
    expect(ctx.sources).toHaveLength(3);
    for (const source of ctx.sources) expect(source.outputs).toContain(ctx.gains[0]);
  });

  it('lays the fade envelope on absolute timeline instants', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0)));
    mix.extend(
      project([clip({ sourceOutMs: 10_000, fadeInMs: 1000, fadeOutMs: 2000 })]),
      0,
      20_000,
    );

    const events = ctx.gains[0]!.gain.events;
    expect(events[0]).toEqual(['set', 0, 0]);
    // Ramps land where the fades are, not where a segment happens to end.
    expect(events.map((e) => e[2])).toEqual([0, 1, 8, 10]);
    expect(events.at(-1)).toEqual(['ramp', 0, 10]);
  });

  it('does not build a chain for a clip whose audio is not decoded yet', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, () => []);
    mix.extend(project([clip()]), 0, 10_000);

    // An idle chain hanging off the bus would also mean the envelope was laid
    // down against a window the clip never actually played in.
    expect(ctx.gains).toHaveLength(0);
    expect(ctx.sources).toHaveLength(0);
  });

  it('stops every source and releases every node', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0), segment(1)));
    mix.extend(project([clip({ sourceOutMs: 40_000 })]), 0, 60_000);
    mix.stop();

    expect(ctx.sources).toHaveLength(2);
    for (const source of ctx.sources) expect(source.disconnected).toBe(1);
    expect(ctx.gains[0]!.disconnected).toBe(1);
    // And a scheduler that has been stopped stays stopped.
    mix.extend(project([clip()]), 0, 10_000);
    expect(ctx.sources).toHaveLength(2);
  });

  it('respects the trim, the track and the clip volume', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0)));
    mix.extend(project([clip({ volume: 0 })]), 0, 10_000);
    expect(ctx.sources).toHaveLength(0);

    mix.extend(project([clip()], { muted: true }), 0, 10_000);
    expect(ctx.sources).toHaveLength(0);
  });

  it('never plays past a clip out point that falls inside a piece', () => {
    const ctx = new FakeCtx();
    const mix = scheduler(ctx, lookupOf(segment(0), segment(1)));
    // Ends 2 s into the second piece.
    mix.extend(project([clip({ sourceInMs: 20_000, sourceOutMs: 32_000 })]), 0, 60_000);

    expect(ctx.sources[1]!.started).toEqual({ when: 10, offset: 0, duration: 2 });
  });
});
