import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite for the SelfCut editor. Chromium only, and specifically the full
 * Chromium build (`channel: 'chromium'`, new headless mode): the app is built
 * on WebCodecs, and the default Playwright headless shell ships a VideoEncoder
 * that stalls forever - imports would decode but the export test would hang.
 */

/**
 * Specs that render: they decode, composite and encode video, and on a machine
 * with no GPU that is the whole machine for the duration.
 *
 * They are a separate project so CI can give them one worker (see check.yml)
 * while the UI specs keep running several at a time. The suite used to run
 * everything at `workers: 2` and the cost was not the renders themselves but
 * the pairings: `editor.spec.ts`'s export takes 8s alone and timed out after
 * FOUR MINUTES next to `exportCodecs`'s software AV1 encode, then burned a
 * retry doing it again. Time was super-linear in the number of tests, which is
 * how ten sub-second `redaction` specs doubled the job.
 *
 * A new spec belongs here if it exports, plays back, or measures a frame
 * budget. Everything else stays in `ui`, which is the default: the list is
 * explicit rather than a naming convention because these filenames have never
 * had one, and a wrong guess here is a flaky suite rather than a loud error.
 */
const RENDER_SPECS = [
  /export.*\.spec\.ts/,
  /memory\.spec\.ts/,
  /perf\.spec\.ts/,
  /previewCuts\.spec\.ts/,
  /transcode.*\.spec\.ts/,
  // Excluded from every default run (see EXCLUDED), but they render harder than
  // anything else here, so when PROBE=1 lets one through it belongs on the
  // single-worker side rather than four-up with the UI specs.
  /probe.*\.spec\.ts/,
];

// Two families are kept out of the default run.
//
// `prod-*` specs test what only exists in a build (the COOP/COEP service
// worker, which is skipped in dev): they run against `vite preview` from
// playwright.prod.config.ts and would fail outright here.
//
// `probe*` specs are ad-hoc investigations - footage supplied on the command
// line, renders that take half an hour. They are useful to run by hand
// (`PROBE=1 npx playwright test e2e/probeSliceRate.spec.ts`) and ruinous in a
// suite: they hold the machine's one hardware encoder for minutes, which times
// out every other export test running beside them.
//
// `PROBE=1` is what lets one be run by hand: without it the pattern below
// hides them from `npx playwright test e2e/probeSliceRate.spec.ts` too, which
// is the very invocation their headers document.
const EXCLUDED = process.env.PROBE
  ? [/prod-.*\.spec\.ts/]
  : [/prod-.*\.spec\.ts/, /probe.*\.spec\.ts/];

export default defineConfig({
  testDir: 'e2e',
  // Video decode/encode dominates test time; keep the budget generous.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // The local default. CI overrides it per project - several workers for `ui`,
  // exactly one for `render` - which is the whole point of the split above.
  workers: 2,
  forbidOnly: !!process.env.CI,
  // One retry, for the genuinely non-deterministic (a codec the machine decides
  // it cannot provide today). It is not a budget for contention: with the
  // render specs serialised there is nothing left for a second attempt to fix,
  // and `failOnFlakyTests` says so out loud rather than letting a pass-on-retry
  // scroll by. Drop that flag before adding a retry back.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    // The editor localizes via the browser language; pin it so text-based
    // selectors always match the English strings.
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'ui',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
      testIgnore: [...EXCLUDED, ...RENDER_SPECS],
    },
    {
      name: 'render',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
      testMatch: RENDER_SPECS,
      testIgnore: EXCLUDED,
    },
  ],
  webServer: {
    command: 'npm run dev',
    // The editor SPA lives at /app/ (the root serves the static landing page).
    url: 'http://localhost:5173/app/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
