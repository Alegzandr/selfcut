import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

import { crossOriginIsolation } from './integrations/crossOriginIsolation';
import { ffmpegCore } from './integrations/ffmpegCore';
import { sitemap } from './integrations/sitemap';
import { ORIGIN } from './src/landing/langs';

// The site is served from the root of the custom domain. Set VITE_BASE to
// build for a subpath instead.
const BASE_PATH = process.env.VITE_BASE ?? '/';

export default defineConfig({
  site: ORIGIN,
  base: BASE_PATH,
  output: 'static',
  // Port kept from the Vite setup so the e2e config and muscle memory hold.
  server: { port: 5173 },
  // The bottom-centre overlay sits exactly where the editor's timeline is, and
  // the e2e suite drives that timeline against the dev server.
  devToolbar: { enabled: false },
  // Nothing goes through astro:assets - every image is a static file in
  // public/ - so the default sharp-backed service is dead weight.
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  build: {
    // /assets/ rather than Astro's /_astro/: the COOP service worker and the
    // CSP were written against that path, and renaming it buys nothing.
    assets: 'assets',
  },
  security: {
    // GitHub Pages allows no HTTP headers, so the policy ships as a meta tag.
    // Astro composes script-src and style-src itself, adding a hash for every
    // script it inlines into a page - which is how the landing's language
    // script stays allowed without ever opening script-src to 'unsafe-inline'.
    csp: {
      directives: [
        "default-src 'self'",
        // blob: for export and media preview, data: for the favicon and
        // thumbnails.
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        // Auto-captions run Whisper locally via transformers.js. The audio
        // never leaves the browser; only the open-source model weights
        // (HuggingFace hub, cached after first download) and the onnxruntime wasm
        // (jsdelivr) are fetched - hence these hosts and the jsdelivr script
        // source below. Self-hosting them like the ffmpeg core would remove them
        // entirely; see captionsModel.ts.
        //
        // `*.hf.co` is not a second vendor: huggingface.co URLs 302 to the CDN
        // that actually serves the weights (`us.aws.cdn.hf.co` today), and CSP
        // checks every hop of a redirect. Without it the download fails on the
        // first byte of the first weight file.
        "connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ],
      scriptDirective: {
        // 'wasm-unsafe-eval' is what lets ffmpeg.wasm compile its module: the
        // narrow WebAssembly-only permission, which does NOT re-enable eval()
        // for scripts. The core is served from our own origin (see the
        // ffmpegCore integration), so no CDN needs allowing for it.
        resources: ["'self'", "'wasm-unsafe-eval'", 'blob:', 'https://cdn.jsdelivr.net'],
      },
      styleDirective: {
        resources: [
          "'self'",
          "'unsafe-inline'",
          // Spelled out for style attributes as well. Astro adds style hashes
          // to style-src, and a directive that carries a hash stops honouring
          // 'unsafe-inline' - which would block every style attribute in the
          // markup, starting with the mock timeline's clip widths.
          { resource: "'unsafe-inline'", kind: 'attribute' },
        ],
      },
    },
  },
  integrations: [react(), ffmpegCore(), crossOriginIsolation(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      // ffmpeg.wasm locates its worker with `new URL('./worker.js', import.meta.url)`.
      // Dep pre-bundling flattens the package into a single chunk, so that URL points
      // at a file that no longer exists and the worker 404s (dev only, silently).
      // transformers.js (captions worker) pulls onnxruntime-web's workers/wasm via
      // import.meta.url like ffmpeg; pre-bundling breaks those URLs.
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'],
      // None of these are reachable from the entry the dev server scans at
      // startup, and every one of them is imported at a moment where re-running
      // the optimizer is destructive: it ends in 'optimized dependencies
      // changed. reloading', which reloads the page out from under whatever it
      // was doing. Listing them pre-bundles them up front instead.
      //
      // framer-motion and mediabunny are behind dynamic imports (the media
      // stack is off the critical path, the animation engine behind LazyMotion),
      // so the scanner only meets them once the page asks - mid-load, where the
      // reload also 504s the pre-bundle the page is already holding.
      //
      // The two encoders are imported statically, but by exportWorker, and the
      // scanner does not follow a worker entry. So they are discovered at the
      // FIRST export of a session, and the reload lands squarely in the middle
      // of that render: the sheet and its worker go away, no file is ever
      // produced, and nothing reports an error - the export simply never ends.
      // In e2e that was the first render spec of the run hanging until its
      // budget expired and passing on the retry, every run.
      include: [
        'framer-motion',
        'mediabunny',
        '@mediabunny/aac-encoder',
        '@mediabunny/mp3-encoder',
      ],
    },
    build: {
      target: 'es2022',
      minify: process.env.ANALYZE ? false : undefined,
      rolldownOptions: process.env.ANALYZE ? { output: { sourcemap: true } } : undefined,
    },
  },
});
