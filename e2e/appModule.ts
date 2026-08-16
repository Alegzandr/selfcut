import type { Page } from '@playwright/test';

/**
 * Reaching the app's OWN module instances from a spec.
 *
 * A spec that wants to read the store, or ask the preview how many decoders it
 * is holding, has to import the very module the running app imported. A plain
 * `import('/src/store/store.ts')` does not do that: Vite appends an HMR
 * timestamp (`?t=…`) to every module it has invalidated since the server
 * started, so after any source edit the app runs `store.ts?t=1786…` while the
 * spec pulls a second, pristine copy of `store.ts` - same code, different
 * module, empty state. The symptom is a store with no project inside a page
 * that visibly has one, which reads as a product bug and is not one.
 *
 * So resolve the specifier against what the page has actually loaded, and only
 * fall back to the bare path when the module is not in the graph yet.
 */
export function appModuleUrl(page: Page, modulePath: string): Promise<string> {
  return resolveLoaded(page, modulePath, false);
}

/**
 * URL of a pre-bundled dependency the app has loaded (Vite serves those from
 * `/node_modules/.vite/deps/` under a content hash, so the path cannot be
 * written down). Throws rather than guessing: a spec that decodes with the
 * app's own mediabunny must not silently fall back to a different copy.
 */
export async function appDepUrl(page: Page, name: string): Promise<string> {
  const url = await resolveLoaded(page, `/deps/${name}`, true);
  if (!url) throw new Error(`dependency '${name}' is not in the page's module graph`);
  return url;
}

function resolveLoaded(page: Page, needle: string, substring: true): Promise<string | null>;
function resolveLoaded(page: Page, needle: string, substring: false): Promise<string>;
function resolveLoaded(page: Page, needle: string, substring: boolean): Promise<string | null> {
  return page.evaluate(
    ({ path, loose }) => {
      const loaded = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => {
          try {
            const { pathname } = new URL(name);
            return loose ? pathname.includes(path) : pathname === path;
          } catch {
            return false;
          }
        })
        // A query-carrying URL is the app's; a bare one would be a spec's copy.
        .sort((a, b) => b.length - a.length);
      return loaded[0] ?? (loose ? null : path);
    },
    { path: needle, loose: substring },
  );
}
