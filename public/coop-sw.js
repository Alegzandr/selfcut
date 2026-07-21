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
 * Only the document is rewritten. COOP and COEP are document-level policies -
 * they do nothing on a subresource - and under `require-corp` a same-origin
 * subresource is allowed without CORP, which every file this app loads is.
 *
 * So subresources are left alone entirely, not even re-fetched. That is not a
 * micro-optimization: proxying means piping the response through
 * `new Response(response.body, ...)`, and the ffmpeg core is a 32 MB stream. The
 * browser is free to kill an idle service worker while such a stream is still
 * open, and when it does the fetch rejects as a bare "Failed to fetch" - a
 * download that worked before this worker existed, broken by the worker meant to
 * make it faster.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate') return;

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
