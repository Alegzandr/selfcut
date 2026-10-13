/**
 * Cross-origin isolation for the editor, from a service worker.
 *
 * ffmpeg.wasm's multi-threaded core runs on SharedArrayBuffer, which a page only
 * gets when it is crossOriginIsolated - and that needs two response headers the
 * host cannot send (the site is static; the CSP already ships as a meta tag for
 * the same reason). A service worker sits between the page and the cache, so it
 * can add them to its own origin's responses.
 *
 * Scoped to /app/ on purpose: the landing pages have nothing to gain from
 * isolation, and COEP would make any cross-origin embed they later grow fail.
 *
 * Isolation is decided when the document is created, so the very first visit is
 * never isolated - this worker only takes effect from the next navigation. That
 * is why registration is silent and never forces a reload: a transcode started
 * today runs single-threaded, and the tab the user opens tomorrow does not.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/**
 * Documents and worker scripts, and nothing else.
 *
 * Documents for the obvious reason. Worker scripts because a dedicated worker
 * owned by a require-corp document is REFUSED unless its own response carries
 * the same policy: an absent header means "unsafe-none", which is incompatible,
 * and the worker fails to start with an ErrorEvent carrying no message. That is
 * how this was found - the page was isolated, so the runtime picked the
 * multi-threaded core, and the core then sat for ever inside a worker that had
 * never come up.
 *
 * Everything else is left alone, not even re-fetched. Under require-corp a
 * same-origin subresource is already allowed without CORP, and every file this
 * app loads is same-origin - so proxying them buys nothing and costs plenty:
 * it pipes each response through `new Response(response.body, ...)`, and the
 * ffmpeg core is a 32 MB stream to hold open across a worker the browser may
 * decide to kill mid-flight.
 */
const WORKER_DESTINATIONS = new Set(['worker', 'sharedworker']);

/** The editor. Registration takes root scope, so the landing pages come through
 * here too and must be handed back exactly as they were: isolation would gain
 * them nothing and COEP would break any cross-origin embed they later grow.
 * Resolved against the scope, which is the site base: a build for a subpath
 * (VITE_BASE) puts the editor under it. */
const EDITOR_PATH = new URL('app/', self.registration.scope).pathname;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const isEditorDocument =
    request.mode === 'navigate' && new URL(request.url).pathname.startsWith(EDITOR_PATH);
  // Worker scripts are rewritten wherever they live: they are served from
  // /assets/, and only the editor ever asks for one.
  if (!isEditorDocument && !WORKER_DESTINATIONS.has(request.destination)) return;

  event.respondWith(
    fetch(request).then((response) => {
      // An opaque or opaqueredirect response has no readable headers or body to
      // copy, and handing one back rewritten would blank it.
      if (response.status === 0 || response.type === 'opaqueredirect') return response;

      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
