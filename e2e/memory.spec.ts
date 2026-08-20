import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * The three resource leaks behind a session that got slower the longer it ran,
 * and then could not export at all.
 *
 * All three are about what the editor KEEPS rather than what it computes, so
 * they only show up over a session's worth of work: a decoder per clip the
 * playhead ever crossed, every source's decoded PCM held forever, and a project
 * write that a busy editor kept pushing out of reach. The policies themselves
 * are unit-tested (cursorPool, mediaCache, saveSchedule); what is checked here
 * is that they are wired into the running app.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');
/** The video fixture carries no sound; the audio cache needs this one. */
const FIXTURE_WAV = path.join(FIXTURES, 'tone.wav');

const EDITOR_URL = '/app/';

const CURSOR_MODULE = '/src/preview/FrameCursor.ts';
const POOL_MODULE = '/src/preview/cursorPool.ts';
const CACHE_MODULE = '/src/media/mediaCache.ts';
const STORE_MODULE = '/src/store/store.ts';
const IDB_MODULE = '/src/lib/idb.ts';

/** How many decode cursors the preview is holding right now. */
async function liveCursors(page: Page): Promise<number> {
  const url = await appModuleUrl(page, CURSOR_MODULE);
  return page.evaluate(async (mod) => {
    const { liveCursorCount } = (await import(mod)) as { liveCursorCount: () => number };
    return liveCursorCount();
  }, url);
}

/** Import the fixture and razor it into `count` clips. */
async function importAndSplit(page: Page, count: number): Promise<void> {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  // The razor cuts at the playhead, so walk it forward a few frames at a time
  // and cut repeatedly: each cut turns the clip under the playhead into two.
  await page.keyboard.press('Home');
  for (let i = 1; i < count; i++) {
    for (let f = 0; f < 6; f++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('s');
  }
  await expect(page.locator('[data-clip-id]')).toHaveCount(count);
}

test('crossing a long timeline does not accumulate decoders', async ({ page }) => {
  const CLIPS = 20;
  await importAndSplit(page, CLIPS);

  const max = await page.evaluate(async (mod) => {
    const { MAX_LIVE_CURSORS } = (await import(mod)) as { MAX_LIVE_CURSORS: number };
    return MAX_LIVE_CURSORS;
  }, await appModuleUrl(page, POOL_MODULE));

  // Walk the playhead across every clip, the way scrubbing through a cut does.
  // Before the pool this left one live decoder per clip visited, released only
  // when that clip was itself deleted.
  await page.keyboard.press('Home');
  let peak = 0;
  let sawOne = false;
  for (let i = 0; i < CLIPS * 5; i++) {
    await page.keyboard.press('ArrowRight');
    if (i % 4 === 0) {
      const live = await liveCursors(page);
      peak = Math.max(peak, live);
      sawOne ||= live > 0;
    }
  }

  // At most a couple of clips are visible at any instant, so the pool never has
  // to run over its ceiling to keep the visible ones alive.
  expect(peak).toBeLessThanOrEqual(max);
  expect(await liveCursors(page)).toBeLessThanOrEqual(max);
  // And the preview really was decoding, rather than reporting an empty pool
  // because nothing was ever drawn.
  expect(sawOne).toBe(true);
});

test('decoded audio is held under a budget, not forever', async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_WAV);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  const state = await page.evaluate(async (mod) => {
    const cache = (await import(mod)) as {
      cachedAudioBytes: () => number;
      audioCacheBudgetBytes: (gb?: number) => number;
    };
    // The warm pass runs behind the import; give it a moment to land.
    for (let i = 0; i < 60 && cache.cachedAudioBytes() === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const memory = (globalThis as { navigator?: { deviceMemory?: number } }).navigator?.deviceMemory;
    return { bytes: cache.cachedAudioBytes(), budget: cache.audioCacheBudgetBytes(memory) };
  }, await appModuleUrl(page, CACHE_MODULE));

  // Wired up: the track really is in the cache and really is MEASURED. An
  // unmeasured entry reads as zero bytes and can never be ranked for eviction,
  // which is exactly how the cache used to grow without bound.
  expect(state.bytes).toBeGreaterThan(0);
  expect(state.bytes).toBeLessThanOrEqual(state.budget);
});

test('an unbroken edit stream still reaches the disk', async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  const mods = {
    store: await appModuleUrl(page, STORE_MODULE),
    idb: await appModuleUrl(page, IDB_MODULE),
  };

  // Let the import settle, so the measurement below only sees the burst. The
  // observable end of "settled" is the project record existing, which is what
  // the burst is then measured against - waiting a flat 1500 ms instead was
  // both slower than it needed to be and no guarantee on a slow machine.
  await expect
    .poll(
      async () =>
        page.evaluate(async ({ store, idb }) => {
          const { useStore } = (await import(store)) as { useStore: { getState: () => never } };
          const { db, PROJECT_STORE, requestDone } = (await import(idb)) as {
            db: () => Promise<{
              transaction: (
                store: string,
                mode: string,
              ) => { objectStore: (name: string) => { get: (key: string) => unknown } };
            }>;
            PROJECT_STORE: string;
            requestDone: (request: unknown) => Promise<unknown>;
          };
          const id = (useStore.getState() as unknown as { project: { id: string } }).project.id;
          const handle = await db();
          const stored = await requestDone(
            handle.transaction(PROJECT_STORE, 'readonly').objectStore(PROJECT_STORE).get(id),
          );
          return stored != null;
        }, mods),
      { message: 'import committed to IndexedDB' },
    )
    .toBe(true);

  const result = await page.evaluate(async ({ store, idb }) => {
    type Clip = { id: string; timelineStartMs: number };
    type Project = { id: string; tracks: { clips: Clip[] }[] };
    const { useStore } = (await import(store)) as {
      useStore: {
        getState: () => {
          project: Project;
          updateClip: (id: string, patch: Record<string, unknown>) => void;
        };
      };
    };
    // Structurally typed, not DOM-typed: this file compiles under the Node
    // tsconfig, which has no `lib.dom`.
    const { db, PROJECT_STORE, requestDone } = (await import(idb)) as {
      db: () => Promise<{
        transaction: (
          store: string,
          mode: string,
        ) => { objectStore: (name: string) => { get: (key: string) => unknown } };
      }>;
      PROJECT_STORE: string;
      requestDone: (request: unknown) => Promise<unknown>;
    };

    const clipId = useStore.getState().project.tracks[0]!.clips[0]!.id;
    const persistedStart = async (): Promise<number | null> => {
      const handle = await db();
      const stored = (await requestDone(
        handle
          .transaction(PROJECT_STORE, 'readonly')
          .objectStore(PROJECT_STORE)
          .get(useStore.getState().project.id),
      )) as Project | undefined;
      const clip = stored?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      return clip?.timelineStartMs ?? null;
    };

    // Four seconds of updates every 16 ms - what a pointermove-driven drag
    // produces. A plain 500 ms debounce never fires under this, because every
    // tick restarts it: the project stayed unwritten for as long as the user
    // kept working, and an unclean exit lost all of it.
    const started = performance.now();
    let ms = 100;
    while (performance.now() - started < 4000) {
      ms += 1;
      useStore.getState().updateClip(clipId, { timelineStartMs: ms });
      await new Promise((r) => setTimeout(r, 16));
    }
    const live = useStore.getState().project.tracks[0]!.clips[0]!.timelineStartMs;
    // Read the disk WITHOUT unloading the page: `pagehide` would flush the
    // pending write and hide the very thing being measured.
    return { live, persisted: await persistedStart() };
  }, mods);

  expect(result.live).toBeGreaterThan(100);
  expect(result.persisted).not.toBeNull();
  // Mid-burst, the disk is at most the save ceiling behind the live timeline.
  // One update per 16 ms means the 2 s ceiling is ~125 steps; the slack absorbs
  // scheduling jitter without letting a never-firing debounce through (which
  // measured ~336 steps behind - the entire burst).
  expect(result.live - result.persisted!).toBeLessThan(220);
});
