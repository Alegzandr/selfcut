/**
 * How long the page may go without a `dragover` before the drag is presumed
 * over. The drag-and-drop model re-fires `dragover` about every 350ms while a
 * drag is live, even with the pointer parked, so a silence this long only
 * happens once the drag really ended - dropped on another app, or cancelled
 * with Escape, neither of which sends the page a final `dragleave`.
 */
export const DRAG_IDLE_MS = 1200;

/**
 * Grace period before a `dragleave` that empties the counter is believed.
 * Crossing from one element to the next fires a leave and an enter, and some
 * browsers send them in that order - acting on the leave at once would blink
 * the overlay off and back on all the way across the editor.
 */
export const DRAG_LEAVE_GRACE_MS = 120;

/** Frequency the host has to call `tick` at for the two delays above to hold. */
export const DRAG_TICK_MS = 100;

export type FileDragTracker = {
  /** A `dragenter` carrying files. */
  enter(nowMs: number): void;
  /** A `dragover` carrying files - also the heartbeat the idle check reads. */
  over(nowMs: number): void;
  /** A `dragleave` carrying files. */
  leave(nowMs: number): void;
  /** The drag is definitively over: a drop, a `dragend`, or an unmount. */
  end(): void;
  /** Timer callback: retires a drag that left quietly. */
  tick(nowMs: number): void;
  readonly active: boolean;
};

/**
 * Tracks whether a file drag from outside the browser is hovering the window.
 *
 * A plain boolean is not enough: `dragenter` and `dragleave` fire once per
 * element the pointer crosses, so they have to be counted rather than read one
 * at a time, and a drag that ends outside the window never sends the page a
 * closing event at all. The counter answers the first, the heartbeat on
 * `dragover` answers the second.
 */
export function createFileDragTracker(onChange: (active: boolean) => void): FileDragTracker {
  let depth = 0;
  let lastSignalMs = 0;
  let leftAtMs = Infinity;
  let active = false;

  const set = (next: boolean) => {
    if (next === active) return;
    active = next;
    onChange(active);
  };

  const seen = (nowMs: number) => {
    lastSignalMs = nowMs;
    leftAtMs = Infinity;
    set(true);
  };

  return {
    enter(nowMs) {
      depth += 1;
      seen(nowMs);
    },
    over(nowMs) {
      // A drag already in flight when the listeners were attached has no enter
      // to its name, and its `dragover` still has to raise the overlay.
      if (depth === 0) depth = 1;
      seen(nowMs);
    },
    leave(nowMs) {
      lastSignalMs = nowMs;
      depth = Math.max(0, depth - 1);
      if (depth === 0) leftAtMs = nowMs;
    },
    end() {
      depth = 0;
      leftAtMs = Infinity;
      set(false);
    },
    tick(nowMs) {
      if (!active) return;
      if (nowMs - leftAtMs >= DRAG_LEAVE_GRACE_MS) this.end();
      else if (nowMs - lastSignalMs >= DRAG_IDLE_MS) this.end();
    },
    get active() {
      return active;
    },
  };
}
