import type { AstroIntegration } from 'astro';

/**
 * Serve COOP/COEP on the dev server so the editor is crossOriginIsolated there
 * too, and the multi-threaded ffmpeg core actually gets exercised during
 * development.
 *
 * Production gets the same headers from a service worker
 * (`public/coop-sw.js`), because a static host sends no headers at all. Dev
 * cannot use that worker: the dev client's own module graph is served from the
 * same origin and the worker only takes effect on the second navigation, which
 * makes HMR reloads confusing.
 *
 * Written as raw middleware rather than `vite.server.headers` so the headers
 * are set on the response before Astro's own handler produces the page.
 */
export function crossOriginIsolation(): AstroIntegration {
  return {
    name: 'selfcut:cross-origin-isolation',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'selfcut:dev-cross-origin-isolation',
                apply: 'serve',
                configureServer(server) {
                  server.middlewares.use((_req, res, next) => {
                    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
                    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
                    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
                    next();
                  });
                },
              },
            ],
          },
        });
      },
    },
  };
}
