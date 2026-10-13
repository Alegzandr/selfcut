import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';

/** Where the files are served, under the site base. The captions worker points
 * transformers.js here (see `ONNX_WASM_DIR` in src/media/captionsWorker.ts). */
const URL_DIR = 'onnxruntime';

/**
 * onnxruntime-web as transformers.js resolves it - from transformers' own
 * location, so a nested copy of a different version would still be the one
 * whose runtime files ship. The package's main entry sits in dist/, next to
 * the wasm builds.
 */
function sourceDir(): string {
  const fromTransformers = createRequire(
    createRequire(import.meta.url).resolve('@huggingface/transformers'),
  );
  return path.dirname(fromTransformers.resolve('onnxruntime-web'));
}

/**
 * The two builds transformers.js picks between: asyncify everywhere, the plain
 * one on Safari < 26 without WebGPU. Which one a visitor needs is only known in
 * their browser, so both ship; only one is ever fetched.
 */
const FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

/**
 * Serve onnxruntime-web's wasm runtime from our own origin at /onnxruntime/.
 *
 * Left alone, transformers.js imports it from cdn.jsdelivr.net at run time -
 * executable code from a third party, with no integrity check, which also kept
 * that whole CDN in the CSP's script-src. Copied out of node_modules like the
 * ffmpeg core, it is the exact version the bundle was built against, and
 * nothing requests it until a transcription runs on the wasm backend.
 */
export function onnxRuntime(): AstroIntegration {
  return {
    name: 'selfcut:onnxruntime',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        const dir = sourceDir();
        // Fail the build rather than ship a dist whose runtime 404s.
        for (const name of FILES) {
          if (!fs.existsSync(path.join(dir, name))) {
            throw new Error(`onnxruntime-web is missing ${name} at ${dir}. Run npm install.`);
          }
        }

        updateConfig({
          vite: {
            plugins: [
              {
                name: 'selfcut:onnxruntime-dev',
                apply: 'serve',
                // Dev has no dist to copy into: hand the files straight off disk.
                configureServer(server) {
                  const prefix = `${server.config.base}${URL_DIR}/`;
                  server.middlewares.use((req, res, next) => {
                    const pathname = req.url?.split('?')[0] ?? '';
                    const name = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
                    if (!FILES.includes(name)) return next();
                    const source = path.join(dir, name);
                    res.setHeader(
                      'Content-Type',
                      name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
                    );
                    res.setHeader('Content-Length', fs.statSync(source).size);
                    fs.createReadStream(source).pipe(res);
                  });
                },
              },
            ],
          },
        });
      },

      'astro:build:done': async ({ dir }) => {
        const outDir = path.join(fileURLToPath(dir), URL_DIR);
        const src = sourceDir();
        await fs.promises.mkdir(outDir, { recursive: true });
        for (const name of FILES) {
          await fs.promises.copyFile(path.join(src, name), path.join(outDir, name));
        }
      },
    },
  };
}
