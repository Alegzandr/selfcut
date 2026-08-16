import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The perf suite, forced onto a software rasterizer.
 *
 * `e2e/renderPath.ts` splits every frame-budget assertion in two: a real
 * budget where there is a GPU to composite on, a collapse detector where there
 * is not. A development machine only ever exercises the first half, so the
 * second half - which is the half that runs on every CI push - would otherwise
 * be code nobody can run before merging it.
 *
 * `--disable-gpu` puts Chromium on SwiftShader for the whole GPU process,
 * which is the same fallback a hosted runner takes when it finds no device.
 * Note that it is not a simulation of the runner's speed: this reproduces the
 * runner's rendering path on the local CPU, so the numbers stay well below
 * what CI reports. The bounds in the specs are calibrated from actual CI runs,
 * not from this.
 *
 *   npm run test:e2e:swiftshader
 */
export default defineConfig({
  ...base,
  // A perf number under a software rasterizer is noisy enough that a retry
  // would only hide it. Fail once and read the printed breakdown.
  retries: 0,
  projects: (base.projects ?? []).map((project) => ({
    ...project,
    use: { ...project.use, launchOptions: { args: ['--disable-gpu'] } },
  })),
});
