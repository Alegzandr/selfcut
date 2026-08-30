import { test as base, expect } from '@playwright/test';

export { expect };
export type { Page } from '@playwright/test';

/**
 * How many resource-timing entries a page keeps.
 *
 * The default is 250, and the browser silently STOPS recording past it - the
 * first 250 are kept and everything after is dropped, with no error. In a Vite
 * dev server every source module is its own request, and this app crossed 250
 * before a file has even been imported. Anything fetched later, which includes
 * the pre-bundled `mediabunny` the decode path pulls in on first use, is then
 * invisible to `performance.getEntriesByType('resource')`.
 *
 * That matters because `appModule.ts` resolves the app's OWN module instances
 * through exactly that list. Past the limit, `appDepUrl` throws (which is how
 * this was found: `exportParallel` failing with "dependency 'mediabunny' is not
 * in the page's module graph"), and `appModuleUrl` does something quieter and
 * worse - it falls back to the bare specifier, handing the spec a second,
 * pristine copy of the store with no project in it. A whole class of specs
 * would have started asserting against the wrong module without ever saying so.
 *
 * Generous on purpose: the cost of a large buffer is a few hundred kilobytes in
 * a page that is already decoding video, and a limit that has to be revisited
 * every time the app grows a few files is a trap that springs again.
 */
const RESOURCE_TIMING_BUFFER = 20_000;

/**
 * The base `test`, with every page set up to record its whole module graph.
 *
 * Applied as an auto fixture rather than a line in each spec: it has to run
 * before the navigation that loads the app, and a spec that forgets it does not
 * fail loudly - it silently resolves the wrong modules.
 */
export const test = base.extend<{ resourceTiming: void }>({
  resourceTiming: [
    async ({ page }, use) => {
      await page.addInitScript((size) => {
        performance.setResourceTimingBufferSize(size);
      }, RESOURCE_TIMING_BUFFER);
      await use();
    },
    { auto: true },
  ],
});
