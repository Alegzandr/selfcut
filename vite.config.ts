import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// GitHub Pages allows no HTTP headers, so the CSP ships as a meta tag injected
// at build time only (the Vite dev server relies on inline scripts). blob: is
// required for export and media preview, data: for the favicon and thumbnails,
// 'unsafe-inline' in style for framer-motion.
// 'wasm-unsafe-eval' is what lets ffmpeg.wasm compile its module: it is the
// narrow WebAssembly-only permission, and does NOT re-enable eval() for scripts.
// The core is served from our own origin (copied out of node_modules at build
// time by copyFFmpegCore), so no CDN needs allowing.
// Auto-captions (desktop only) run Whisper locally via transformers.js. The audio
// never leaves the browser; only the open-source model weights (HuggingFace hub,
// cached after first download) and the onnxruntime wasm (jsdelivr) are fetched —
// hence the connect-src/script-src hosts. Self-hosting them like the ffmpeg core
// would remove the hosts entirely; see captionsModel.ts.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self' https://huggingface.co https://*.huggingface.co https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

/**
 * Serve ffmpeg.wasm's core from our own origin at /ffmpeg/.
 *
 * The core is 32 MB, so it is copied straight out of node_modules rather than
 * committed to the repo or pushed through rollup's asset pipeline. Nothing
 * requests it until the user asks to transcode an undecodable audio track, so
 * it never weighs on a normal page load.
 */
function copyFFmpegCore(): Plugin {
  // The ESM build, not the UMD one. ffmpeg.wasm spawns its worker with
  // `type: 'module'`, where importScripts() does not exist: its loader falls back
  // to `import(coreURL)` and reads `.default`, which a UMD bundle does not have.
  // Pointing at UMD makes load() fail with "failed to import ffmpeg-core.js".
  // require.resolve picks the "require" condition (UMD), so cross over by hand;
  // the package exports no './package.json' to resolve against directly.
  const esmDirOf = (pkg: string) =>
    path.join(path.dirname(require.resolve(pkg)), '..', 'esm');

  // Both builds ship. Only one is ever fetched - the runtime picks by
  // crossOriginIsolated - but which one that is depends on whether the service
  // worker has taken over, which is not knowable at build time.
  const cores = [
    { url: 'ffmpeg', dir: esmDirOf('@ffmpeg/core'), files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] },
    {
      url: 'ffmpeg-mt',
      dir: esmDirOf('@ffmpeg/core-mt'),
      // The MT core spawns its threads from ffmpeg-core.worker.js, which its
      // own glue resolves next to the main script: it has to be there.
      files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'],
    },
  ];

  return {
    name: 'copy-ffmpeg-core',
    // Dev has no dist to copy into: hand the files straight off disk instead.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const core = cores.find((c) => req.url?.startsWith(`/${c.url}/`));
        const name = core?.files.find((f) => req.url?.startsWith(`/${core.url}/${f}`));
        if (!core || !name) return next();
        const source = path.join(core.dir, name);
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        // Announce the size so the download reports real progress in dev too,
        // instead of an indeterminate bar the production build does not have.
        res.setHeader('Content-Length', fs.statSync(source).size);
        fs.createReadStream(source).pipe(res);
      });
    },
    buildStart() {
      // Fail the build rather than ship a dist whose core 404s at runtime.
      for (const core of cores) {
        for (const name of core.files) {
          if (!fs.existsSync(path.join(core.dir, name))) {
            this.error(`ffmpeg core is missing ${name} at ${core.dir}. Run npm install.`);
          }
        }
      }
    },
    async writeBundle(options) {
      const outDir = options.dir ?? 'dist';
      for (const core of cores) {
        await fs.promises.mkdir(path.join(outDir, core.url), { recursive: true });
        for (const name of core.files) {
          await fs.promises.copyFile(
            path.join(core.dir, name),
            path.join(outDir, core.url, name),
          );
        }
      }
    },
  };
}

/**
 * Serve COOP/COEP on the dev server so the editor is crossOriginIsolated there
 * too, and the multi-threaded core actually gets exercised during development.
 *
 * Production gets the same headers from a service worker (`public/coop-sw.js`),
 * because a static host sends no headers at all. Dev cannot use that worker: the
 * Vite client's own module graph is served from the same origin and the worker
 * only takes effect on the second navigation, which makes HMR reloads confusing.
 */
function devCrossOriginIsolation(): Plugin {
  return {
    name: 'dev-cross-origin-isolation',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        next();
      });
    },
  };
}

// The site is served from the root of the custom domain
// (https://selfcut.alegzandr.com). Set VITE_BASE to override.
const BASE_PATH = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base: BASE_PATH,
  // Static landing pages (one per language, generated by
  // scripts/build-landing.mjs) and the editor SPA at /app/.
  appType: 'mpa',
  plugins: [
    react(),
    tailwindcss(),
    injectCsp(),
    copyFFmpegCore(),
    devCrossOriginIsolation(),
  ],
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
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        landing: 'index.html',
        'landing-en': 'en/index.html',
        'landing-es': 'es/index.html',
        'landing-de': 'de/index.html',
        'landing-pt-br': 'pt-BR/index.html',
        app: 'app/index.html',
      },
    },
  },
});
