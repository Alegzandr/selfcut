/**
 * mediabunny, loaded on demand.
 *
 * The demuxer/muxer stack is the single largest thing the editor's main-thread
 * bundle carried, and none of it is needed to paint the editor: the shell, the
 * timeline, the store and the preview loop all boot without a media file in
 * sight. Making it a static import meant every visitor downloaded, parsed and
 * compiled it before the first frame of UI, including the ones who came to look
 * at a restored empty project.
 *
 * It is NOT lazy in the sense of "loaded late". It is loaded off the critical
 * path and warmed as soon as the browser is idle, so by the time anyone drags a
 * file in it is already there. The dynamic import is memoized, so the second
 * caller gets the resolved module and never a second network trip.
 *
 * (The export worker and the frame worker each import it statically. They are
 * separate bundles and both exist only to do media work, so there is nothing to
 * defer there.)
 */
type Mediabunny = typeof import('./mediabunnyMain');

let pending: Promise<Mediabunny> | null = null;

/** The module, loading it if this is the first ask. */
export function mediabunny(): Promise<Mediabunny> {
  pending ??= import('./mediabunnyMain');
  return pending;
}

/**
 * Start fetching it without waiting. Called once the editor has painted, so the
 * download overlaps the time the user spends looking at an empty timeline
 * instead of the time they spend waiting for their first import.
 */
export function warmMediabunny(): void {
  if (pending) return;
  const kick = (): void => {
    void mediabunny().catch(() => {
      // A failed prefetch is not an error: the real call will retry and report.
      pending = null;
    });
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (idle) idle(kick, { timeout: 3000 });
  else setTimeout(kick, 300);
}
