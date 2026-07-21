/**
 * Register the service worker that makes the editor crossOriginIsolated.
 *
 * See `public/coop-sw.js` for what it does and why it has to be a worker. What
 * matters here is when: registration is fire-and-forget and never reloads the
 * page. Isolation is a property of the document, fixed when it was created, so
 * it cannot be granted to the tab that installs the worker - only to the next
 * one. Forcing a reload to close that gap would throw away whatever the user was
 * doing for a speedup they have not asked for yet.
 *
 * The cost of getting it wrong is nil: without isolation the ffmpeg runtime
 * loads the single-threaded core, which is what shipped before this existed.
 */
export function registerCoopWorker(): void {
  // Dev serves the headers from the Vite server itself (see
  // devCrossOriginIsolation in vite.config.ts), so the worker has nothing to add
  // there - and plenty to break: it sits in front of every response under /app/
  // and rewrites it, which is not something the dev module graph, HMR and the
  // export's download stream should have to survive for no gain.
  if (import.meta.env.DEV) return;
  // Absent in non-secure contexts and in some private-browsing modes.
  if (!('serviceWorker' in navigator)) return;

  // Root scope, not /app/. Scope decides which requests reach the worker at
  // all, and the editor's own worker chunks are served from /assets/ - outside
  // /app/, so under a narrower scope nothing handled them and they never got the
  // COEP header a worker needs to start under an isolated document. The landing
  // pages are still left untouched: the worker itself filters by URL (see
  // public/coop-sw.js), which scope alone could not express.
  const url = `${import.meta.env.BASE_URL}coop-sw.js`;
  const scope = new URL(import.meta.env.BASE_URL, location.href).href;

  void (async () => {
    try {
      // An earlier version registered this same script under /app/. Registrations
      // are keyed by scope, so shipping a wider one does not replace it: the most
      // specific scope wins, and /app/ is more specific than /. The stale
      // registration would go on controlling the editor - and go on being the
      // reason worker chunks never get their headers - until it is removed by
      // hand. Deliberately not written as "unregister anything that is not ours":
      // this owns the coop worker, not the origin's registrations.
      const stale = (await navigator.serviceWorker.getRegistrations()).filter(
        (reg) => reg.scope !== scope && new URL(reg.scope).pathname.startsWith('/app/'),
      );
      for (const reg of stale) await reg.unregister();

      await navigator.serviceWorker.register(url, { scope });
    } catch (err) {
      // Nothing to tell the user: this is an optimization that did not take.
      console.warn('[coop] service worker registration failed:', err);
    }
  })();
}
