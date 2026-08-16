import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';

const require = createRequire(import.meta.url);

/**
 * The ESM build, not the UMD one. ffmpeg.wasm spawns its worker with
 * `type: 'module'`, where importScripts() does not exist: its loader falls back
 * to `import(coreURL)` and reads `.default`, which a UMD bundle does not have.
 * Pointing at UMD makes load() fail with "failed to import ffmpeg-core.js".
 * require.resolve picks the "require" condition (UMD), so cross over by hand;
 * the package exports no './package.json' to resolve against directly.
 */
const esmDirOf = (pkg: string) => path.join(path.dirname(require.resolve(pkg)), '..', 'esm');

/**
 * Both builds ship. Only one is ever fetched - the runtime picks by
 * crossOriginIsolated - but which one that is depends on whether the service
 * worker has taken over, which is not knowable at build time.
 */
function cores() {
  return [
    {
      url: 'ffmpeg',
      dir: esmDirOf('@ffmpeg/core'),
      files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'],
    },
    {
      url: 'ffmpeg-mt',
      dir: esmDirOf('@ffmpeg/core-mt'),
      // The MT core spawns its threads from ffmpeg-core.worker.js, which its
      // own glue resolves next to the main script: it has to be there.
      files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'],
    },
  ];
}

/**
 * Serve ffmpeg.wasm's core from our own origin at /ffmpeg/ and /ffmpeg-mt/.
 *
 * The core is 32 MB, so it is copied straight out of node_modules rather than
 * committed to the repo or pushed through the asset pipeline. Nothing requests
 * it until the user asks to transcode an undecodable audio track, so it never
 * weighs on a normal page load.
 */
export function ffmpegCore(): AstroIntegration {
  return {
    name: 'selfcut:ffmpeg-core',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        // Fail the build rather than ship a dist whose core 404s at runtime.
        for (const core of cores()) {
          for (const name of core.files) {
            if (!fs.existsSync(path.join(core.dir, name))) {
              throw new Error(
                `ffmpeg core is missing ${name} at ${core.dir}. Run npm install.`,
              );
            }
          }
        }

        updateConfig({
          vite: {
            plugins: [
              {
                name: 'selfcut:ffmpeg-core-dev',
                apply: 'serve',
                // Dev has no dist to copy into: hand the files straight off disk.
                configureServer(server) {
                  server.middlewares.use((req, res, next) => {
                    const core = cores().find((c) => req.url?.startsWith(`/${c.url}/`));
                    const name = core?.files.find((f) => req.url?.startsWith(`/${core.url}/${f}`));
                    if (!core || !name) return next();
                    const source = path.join(core.dir, name);
                    res.setHeader(
                      'Content-Type',
                      name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
                    );
                    // Announce the size so the download reports real progress in
                    // dev too, instead of an indeterminate bar production has not.
                    res.setHeader('Content-Length', fs.statSync(source).size);
                    fs.createReadStream(source).pipe(res);
                  });
                },
              },
            ],
          },
        });
      },

      // Copied here rather than from a rollup hook: Astro runs several Vite
      // builds per `astro build`, and only this hook knows the final output.
      'astro:build:done': async ({ dir }) => {
        const outDir = fileURLToPath(dir);
        for (const core of cores()) {
          await fs.promises.mkdir(path.join(outDir, core.url), { recursive: true });
          for (const name of core.files) {
            await fs.promises.copyFile(
              path.join(core.dir, name),
              path.join(outDir, core.url, name),
            );
          }
        }
      },
    },
  };
}
