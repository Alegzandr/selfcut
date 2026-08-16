/**
 * Frame instrumentation.
 *
 * Every render path in the app - the preview loop, the compositor, the colour
 * pass, the export worker - reports into this module, so "where does the frame
 * budget go" is a readable number instead of a guess. It has to be safe to call
 * from the hot loop, which sets three constraints:
 *
 *  - Off by default and free when off. `enabled` is a module-level boolean read
 *    before anything else; a disabled `span()` returns a sentinel and `end()`
 *    exits on the first comparison. No allocation, no `performance.now()`.
 *  - No allocation when on. Channels are created once per name and hold a
 *    preallocated `Float64Array` ring, so recording a sample is one store and
 *    two integer updates. Nothing here can trigger a GC pause it would then
 *    blame the renderer for.
 *  - Thread-local by construction. The preview (main thread) and the export
 *    worker each import their own copy; the worker ships snapshots across with
 *    `snapshot()` rather than sharing state.
 *
 * A "frame" is closed by `endFrame()`, which rolls the per-frame counters into
 * their channels and notifies subscribers at most `PUBLISH_INTERVAL_MS` apart -
 * so the HUD repainting never becomes the thing the HUD is measuring.
 */

/** Samples a channel keeps. 120 frames is two seconds at 60 fps. */
export const PERF_WINDOW = 120;

/** Minimum gap between two notifications to subscribers. */
const PUBLISH_INTERVAL_MS = 250;

/** Returned by `span()` when instrumentation is off, and ignored by `end()`. */
const NO_SPAN = -1;

export interface ChannelStats {
  name: string;
  /** Most recent sample. */
  last: number;
  mean: number;
  /** 95th percentile over the window - the stutter, not the average. */
  p95: number;
  max: number;
  /** Samples in the window. */
  n: number;
}

export interface PerfSnapshot {
  /** Timings in milliseconds, sorted by mean descending. */
  timings: ChannelStats[];
  /** Per-frame counts (clips drawn, texture uploads, ...). */
  counters: ChannelStats[];
  /** Frames closed since the process started. */
  frames: number;
  /** Frames whose total exceeded `frameBudgetMs`. */
  overBudget: number;
  /** The budget `overBudget` is counted against. */
  frameBudgetMs: number;
  /**
   * Threads the measurement came from. 1 for a single loop; more when several
   * workers were merged, which is what a fanned-out export produces.
   */
  workers?: number;
}

/**
 * A fixed-size ring of samples with the summary statistics computed on demand.
 * Exported so the budget tests can assert on it directly without a render loop.
 */
export class Rolling {
  private readonly ring = new Float64Array(PERF_WINDOW);
  /** Next slot to write. */
  private head = 0;
  /** Samples held, saturating at PERF_WINDOW. */
  private filled = 0;
  private lastValue = 0;

  push(v: number): void {
    this.ring[this.head] = v;
    this.head = (this.head + 1) % PERF_WINDOW;
    if (this.filled < PERF_WINDOW) this.filled++;
    this.lastValue = v;
  }

  get n(): number {
    return this.filled;
  }

  get last(): number {
    return this.lastValue;
  }

  /**
   * Summarize the window. Allocates (a sorted copy, for the percentile), so it
   * is called on publish - a few times a second - never per frame.
   */
  stats(name: string): ChannelStats {
    if (this.filled === 0) return { name, last: 0, mean: 0, p95: 0, max: 0, n: 0 };
    const sorted = new Float64Array(this.filled);
    let sum = 0;
    for (let i = 0; i < this.filled; i++) {
      const v = this.ring[i]!;
      sorted[i] = v;
      sum += v;
    }
    sorted.sort();
    // Nearest-rank p95: for n < 20 this lands on the maximum, which is the
    // honest answer - a 12-sample window cannot resolve a 95th percentile.
    const rank = Math.min(this.filled - 1, Math.ceil(0.95 * this.filled) - 1);
    return {
      name,
      last: this.lastValue,
      mean: sum / this.filled,
      p95: sorted[Math.max(0, rank)]!,
      max: sorted[this.filled - 1]!,
      n: this.filled,
    };
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.lastValue = 0;
  }
}

/** Whether anything is recorded. Read on every hot-path call, so keep it a plain boolean. */
let enabled = false;

const timings = new Map<string, Rolling>();
const counters = new Map<string, Rolling>();
/** Accumulated within the current frame, rolled into `timings` by `endFrame`. */
const frameTiming = new Map<string, number>();
const frameCount = new Map<string, number>();

let frames = 0;
let overBudget = 0;
let frameBudgetMs = 1000 / 60;
let lastPublish = 0;

const listeners = new Set<(snap: PerfSnapshot) => void>();

function channel(map: Map<string, Rolling>, name: string): Rolling {
  let c = map.get(name);
  if (!c) {
    c = new Rolling();
    map.set(name, c);
  }
  return c;
}

/** Whether instrumentation is recording. */
export function perfEnabled(): boolean {
  return enabled;
}

/**
 * Turn instrumentation on or off. Turning it off drops nothing, so a HUD can be
 * closed and reopened without losing the window; `perfReset` clears.
 */
export function setPerfEnabled(on: boolean): void {
  enabled = on;
}

/** The per-frame budget `overBudget` counts against (1000/fps). */
export function setPerfFrameBudget(ms: number): void {
  frameBudgetMs = ms;
}

/**
 * Open a timing span. Returns a token to hand back to `endSpan`. Off: returns
 * `NO_SPAN` without reading the clock, which is the whole point of the guard.
 */
export function span(): number {
  return enabled ? performance.now() : NO_SPAN;
}

/** Close a span opened by `span()`, accumulating into this frame's `name` bucket. */
export function endSpan(name: string, started: number): void {
  if (started === NO_SPAN) return;
  const dt = performance.now() - started;
  frameTiming.set(name, (frameTiming.get(name) ?? 0) + dt);
}

/** Add to a per-frame counter (clips drawn, texture uploads, decoder waits). */
export function count(name: string, n = 1): void {
  if (!enabled) return;
  frameCount.set(name, (frameCount.get(name) ?? 0) + n);
}

/** Record a value directly into a timing channel (for spans measured elsewhere). */
export function record(name: string, ms: number): void {
  if (!enabled) return;
  frameTiming.set(name, (frameTiming.get(name) ?? 0) + ms);
}

/**
 * Close the current frame: roll the accumulators into their channels, count the
 * frame against the budget, and publish if the interval has elapsed.
 *
 * `totalName` names the channel that represents the whole frame; it is the one
 * compared to the budget. Channels not touched this frame receive a 0 sample,
 * so a mean stays honest when a cost appears only intermittently (a mask on one
 * clip in ten frames must not read as if it cost that much every frame).
 */
export function endFrame(totalName = 'frame'): void {
  if (!enabled) return;
  frames++;
  for (const [name, c] of timings) c.push(frameTiming.get(name) ?? 0);
  for (const [name, value] of frameTiming) {
    if (!timings.has(name)) channel(timings, name).push(value);
  }
  for (const [name, c] of counters) c.push(frameCount.get(name) ?? 0);
  for (const [name, value] of frameCount) {
    if (!counters.has(name)) channel(counters, name).push(value);
  }
  const total = frameTiming.get(totalName) ?? 0;
  if (total > frameBudgetMs) overBudget++;
  frameTiming.clear();
  frameCount.clear();

  if (listeners.size === 0) return;
  const now = performance.now();
  if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
  lastPublish = now;
  const snap = snapshot();
  for (const fn of listeners) fn(snap);
}

/** Current statistics for every channel. Allocates; call it on publish, not per frame. */
export function snapshot(): PerfSnapshot {
  const t: ChannelStats[] = [];
  for (const [name, c] of timings) t.push(c.stats(name));
  t.sort((a, b) => b.mean - a.mean);
  const k: ChannelStats[] = [];
  for (const [name, c] of counters) k.push(c.stats(name));
  k.sort((a, b) => b.mean - a.mean);
  return { timings: t, counters: k, frames, overBudget, frameBudgetMs };
}

/**
 * Combine snapshots taken on several threads into one.
 *
 * A fanned-out export has no single frame loop to read: each segment worker
 * measures its own slice. Merging them by a frame-weighted mean gives the
 * per-frame cost of the render as a whole, which is the number that compares to
 * a serial render's. `p95` and `max` are taken as the worst any thread saw -
 * a stutter on one worker is a stutter in the output.
 */
export function mergeSnapshots(parts: PerfSnapshot[]): PerfSnapshot {
  const usable = parts.filter((p) => p.frames > 0);
  if (usable.length === 0) return { timings: [], counters: [], frames: 0, overBudget: 0, frameBudgetMs: 1000 / 60 };

  const merge = (pick: (p: PerfSnapshot) => ChannelStats[]): ChannelStats[] => {
    const acc = new Map<string, { weighted: number; frames: number; p95: number; max: number; last: number; n: number }>();
    for (const part of usable) {
      for (const c of pick(part)) {
        const entry = acc.get(c.name) ?? { weighted: 0, frames: 0, p95: 0, max: 0, last: 0, n: 0 };
        entry.weighted += c.mean * part.frames;
        entry.frames += part.frames;
        entry.p95 = Math.max(entry.p95, c.p95);
        entry.max = Math.max(entry.max, c.max);
        entry.last = c.last;
        entry.n += c.n;
        acc.set(c.name, entry);
      }
    }
    return [...acc]
      .map(([name, e]) => ({ name, mean: e.frames > 0 ? e.weighted / e.frames : 0, p95: e.p95, max: e.max, last: e.last, n: e.n }))
      .sort((a, b) => b.mean - a.mean);
  };

  return {
    timings: merge((p) => p.timings),
    counters: merge((p) => p.counters),
    frames: usable.reduce((sum, p) => sum + p.frames, 0),
    overBudget: usable.reduce((sum, p) => sum + p.overBudget, 0),
    frameBudgetMs: usable[0]!.frameBudgetMs,
  };
}

/** Drop every window and counter (used when switching projects, and by tests). */
export function perfReset(): void {
  timings.clear();
  counters.clear();
  frameTiming.clear();
  frameCount.clear();
  frames = 0;
  overBudget = 0;
  lastPublish = 0;
}

/**
 * Subscribe to snapshots. Subscribing does NOT enable instrumentation - the HUD
 * owns that decision - so a listener attached by a background panel never turns
 * the cost on by itself.
 */
export function subscribePerf(fn: (snap: PerfSnapshot) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Feed a snapshot produced on another thread (the export worker) to listeners. */
export function publishForeignSnapshot(snap: PerfSnapshot): void {
  for (const fn of listeners) fn(snap);
}
