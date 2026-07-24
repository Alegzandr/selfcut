/**
 * Tiny pub/sub for downsampled preview frames, decoupling the playback engine
 * from the video scopes panel. Mirrors `meterBus`: the engine publishes a small
 * RGBA snapshot of the composited frame every time it repaints, but ONLY while a
 * scope is mounted, so a closed scopes panel costs the render loop nothing.
 */
export interface ScopeFrame {
  /** RGBA pixels, row-major, `width * height * 4` bytes. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const listeners = new Set<(frame: ScopeFrame) => void>();

export function publishScopeFrame(frame: ScopeFrame): void {
  for (const fn of listeners) fn(frame);
}

/**
 * Whether a scope is currently mounted. The engine downsamples the frame and
 * reads back its pixels every repaint to feed these, which is pure waste when
 * the scopes panel is closed — the overwhelmingly common case.
 */
export function hasScopeListeners(): boolean {
  return listeners.size > 0;
}

export function subscribeScopeFrame(fn: (frame: ScopeFrame) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
