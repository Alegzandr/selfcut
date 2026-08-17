import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';
import { renderPath } from './renderPath';

/**
 * What the preview loop actually costs, measured in a real browser.
 *
 * The unit budgets in `src/perf/*.bench.ts` cover the pure logic; they cannot
 * see a texture upload, a canvas blit or a decoder wait, which is where a video
 * editor's frame budget really goes. This suite drives the running editor,
 * turns the probe on, plays, and reads the same numbers the HUD shows.
 *
 * The assertions are structural rather than absolute wherever possible - "the
 * graded path uploaded the frame directly and copied it zero times", "a small
 * mask touched a fraction of the frame" - because those hold on any machine,
 * while a millisecond threshold only holds on the machine it was written on.
 * The few timing assertions are deliberately loose and exist to catch an order
 * of magnitude, not a regression of ten percent.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');
const EDITOR_URL = '/app/';

const PROBE_MODULE = '/src/perf/probe.ts';
const STORE_MODULE = '/src/store/store.ts';

interface ChannelStats {
  name: string;
  last: number;
  mean: number;
  p95: number;
  max: number;
  n: number;
}
interface Snapshot {
  timings: ChannelStats[];
  counters: ChannelStats[];
  frames: number;
  overBudget: number;
  frameBudgetMs: number;
}

async function setProbe(page: Page, on: boolean): Promise<void> {
  const url = await appModuleUrl(page, PROBE_MODULE);
  await page.evaluate(
    async ({ mod, enable }) => {
      const p = (await import(mod)) as {
        setPerfEnabled: (v: boolean) => void;
        perfReset: () => void;
      };
      p.perfReset();
      p.setPerfEnabled(enable);
    },
    { mod: url, enable: on },
  );
}

async function snapshot(page: Page): Promise<Snapshot> {
  const url = await appModuleUrl(page, PROBE_MODULE);
  return page.evaluate(async (mod) => {
    const probe = (await import(mod)) as { snapshot: () => Snapshot };
    return probe.snapshot();
  }, url);
}

function timing(snap: Snapshot, name: string): ChannelStats | undefined {
  return snap.timings.find((t) => t.name === name);
}
function counter(snap: Snapshot, name: string): ChannelStats | undefined {
  return snap.counters.find((c) => c.name === name);
}

/** Print the frame breakdown, so a failing run says WHERE the time went. */
function report(title: string, snap: Snapshot): void {
  const lines = [`\n--- ${title} (${snap.frames} frames) ---`];
  for (const t of snap.timings) {
    if (t.mean < 0.005) continue;
    lines.push(`  ${t.name.padEnd(14)} mean ${t.mean.toFixed(3)} ms   p95 ${t.p95.toFixed(2)} ms`);
  }
  for (const c of snap.counters) {
    if (c.mean === 0) continue;
    lines.push(`  #${c.name.padEnd(13)} mean ${c.mean.toFixed(2)}        max ${c.max.toFixed(0)}`);
  }
  lines.push(`  over budget: ${snap.overBudget}/${snap.frames} at ${snap.frameBudgetMs.toFixed(1)} ms`);
  console.log(lines.join('\n'));
}

/** Import the fixture and wait for its clip to land on the timeline. */
async function importClip(page: Page): Promise<void> {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
}

/** Play from the start for `ms`, then pause. */
async function playFor(page: Page, ms: number): Promise<void> {
  const url = await appModuleUrl(page, STORE_MODULE);
  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
    const s = useStore.getState() as unknown as { seek: (v: number) => void; setPlaying: (v: boolean) => void };
    s.seek(0);
    s.setPlaying(true);
  }, url);
  await page.waitForTimeout(ms);
  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
    (useStore.getState() as unknown as { setPlaying: (v: boolean) => void }).setPlaying(false);
  }, url);
}

/** Apply a colour adjustment to every clip, which is what arms the grade pass. */
async function gradeEveryClip(page: Page): Promise<void> {
  const url = await appModuleUrl(page, STORE_MODULE);
  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
    const s = useStore.getState() as unknown as {
      project: { tracks: { clips: { id: string }[] }[] };
      updateClipColorLive: (id: string, prop: string, value: number, timelineMs: number) => void;
    };
    for (const track of s.project.tracks) {
      for (const clip of track.clips) {
        s.updateClipColorLive(clip.id, 'saturation', 0.3, 0);
        s.updateClipColorLive(clip.id, 'contrast', 0.15, 0);
      }
    }
  }, url);
}

test('the preview loop holds its frame budget on an ordinary clip', async ({ page }) => {
  await importClip(page);
  const gpu = await renderPath(page);
  await setProbe(page, true);
  await playFor(page, 2500);

  const snap = await snapshot(page);
  report('preview, ungraded', snap);

  expect(snap.frames).toBeGreaterThan(30);

  // Frames the renderer could not keep up with. Audio is the clock, so this is
  // the number that corresponds to what the eye actually sees - and therefore a
  // number about the machine's compositor as much as about this code. Keeping
  // up with a 30 fps source is a claim about a GPU: the same clip on a software
  // rasterizer measured 1.0-2.8 dropped frames per drawn frame across three CI
  // runs, which is the rasterizer answering, not a regression.
  const dropped = counter(snap, 'droppedFrames');
  const draw = timing(snap, 'draw');
  expect(draw).toBeDefined();

  if (gpu.hardware) {
    expect(dropped?.mean ?? 0).toBeLessThan(1);
    // The composite itself, on a single 1080p-class clip, must be a small
    // fraction of a 60 fps budget. Loose by an order of magnitude: this is here
    // to catch "compositing became the bottleneck", not a 10% drift.
    expect(draw!.mean).toBeLessThan(8);
  } else {
    // Bounds at roughly three times the worst software measurement (2.8 dropped,
    // 6.1 ms of draw), so they still catch a collapse - one clip costing what
    // the three-layer worst case costs - without asserting the runner's GPU.
    expect(dropped?.mean ?? 0).toBeLessThan(8);
    expect(draw!.mean).toBeLessThan(20);
  }
});

test('a graded clip reaches the GPU without an intermediate canvas', async ({ page }) => {
  await importClip(page);
  await gradeEveryClip(page);
  await setProbe(page, true);
  await playFor(page, 2000);

  const snap = await snapshot(page);
  report('preview, graded', snap);

  // The grade ran at all: without this the two upload counters would both be
  // zero and the test would pass by doing nothing.
  const graded = counter(snap, 'gradedClips');
  expect(graded?.max ?? 0).toBeGreaterThan(0);

  // The frame went straight from the decoder into a texture. The path this
  // replaces rasterized every frame into a full-size 2D canvas first, which was
  // a full-frame copy AND a full-frame 8-bit quantization per clip per frame.
  const direct = counter(snap, 'texUploadDirect');
  const copied = counter(snap, 'texUploadCopy');
  expect(direct?.max ?? 0).toBeGreaterThan(0);
  expect(copied?.max ?? 0).toBe(0);
});

test('a small mask costs a small region, not a full frame', async ({ page }) => {
  await importClip(page);

  const url = await appModuleUrl(page, STORE_MODULE);
  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
    const s = useStore.getState() as unknown as {
      project: { tracks: { clips: { id: string }[] }[] };
      setClipMask: (id: string, mask: unknown) => void;
    };
    const clip = s.project.tracks.flatMap((t) => t.clips)[0]!;
    // A quarter of the frame across, a quarter down: 1/16 of the area.
    s.setClipMask(clip.id, {
      shape: 'ellipse',
      x: 0.5,
      y: 0.5,
      w: 0.25,
      h: 0.25,
      feather: 0,
    });
  }, url);

  await setProbe(page, true);
  await playFor(page, 2000);

  const snap = await snapshot(page);
  report('preview, masked', snap);

  const px = counter(snap, 'maskPx');
  expect(px?.max ?? 0).toBeGreaterThan(0);
  // The composite is 1920x1080 at the default half-resolution rung, so a
  // sixteenth-area mask must touch well under a fifth of it. The old path
  // cleared, drew, matted and copied the whole frame, four times over.
  const fullFrame = 1920 * 1080;
  expect(px!.max).toBeLessThan(fullFrame * 0.2);
});

test('three graded, masked, blurred layers at full resolution still hold', async ({ page }) => {
  // The scenario the main-thread compositor was supposed to fall over on:
  // full-resolution composite, three stacked video tracks, every clip graded,
  // masked and blurred at once. Nothing here is a realistic grade - it is a
  // deliberate worst case for the per-clip work.
  await importClip(page);

  const url = await appModuleUrl(page, STORE_MODULE);
  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: { getState: () => never; setState: (p: unknown) => void };
    };
    const state = useStore.getState() as unknown as {
      project: { tracks: { id: string; kind: string; clips: Record<string, unknown>[] }[] };
      setPreviewResolution: (r: string) => void;
    };
    const source = state.project.tracks.find((t) => t.kind === 'video' && t.clips.length > 0)!;
    const layers = [0, 1, 2].map((i) => ({
      ...source,
      id: `perf-track-${i}`,
      clips: source.clips.map((c, j) => ({
        ...c,
        id: `perf-clip-${i}-${j}`,
        trackId: `perf-track-${i}`,
        color: { saturation: 0.4, contrast: 0.2, temperature: 0.2, vignette: 0.4, blur: 0.05 },
        mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0.02 },
      })),
    }));
    useStore.setState({
      project: {
        ...state.project,
        tracks: [...layers, ...state.project.tracks.filter((t) => t.kind !== 'video')],
      },
    });
    state.setPreviewResolution('full');
  }, url);

  const gpu = await renderPath(page);
  await setProbe(page, true);
  await playFor(page, 3000);

  const snap = await snapshot(page);
  report('preview, 3 layers at full res, graded + masked + blurred', snap);

  // Three clips composited per drawn frame, so the scenario really did build.
  expect(counter(snap, 'clipDraws')!.max).toBeGreaterThanOrEqual(3);
  expect(counter(snap, 'gradedClips')!.max).toBeGreaterThanOrEqual(3);
  // The blur really is on: it has its own timing channel precisely because its
  // cost belongs to the browser's filter implementation and not to this code.
  expect(timing(snap, 'blur')).toBeDefined();

  // Long blocks on the main thread - React reconciliation, a garbage
  // collection, a synchronous readback - land here whatever their source.
  //
  // Not a display-rate measurement: headless Chromium does not vsync-lock rAF,
  // so the mean gap is far below 16.7 ms and says nothing about smoothness. The
  // p95 bound is what matters, and it is what catches a stall.
  const gap = timing(snap, 'tickGap')!;

  if (gpu.hardware) {
    // Still inside a 60 fps budget, with everything on. This is the claim the
    // whole "compositing has to leave the main thread" argument rested on, and
    // it is a claim about a GPU: three full-resolution layers through a
    // software rasterizer cost two orders of magnitude more and always will.
    //
    // Read `draw` for what it is: CPU time spent issuing the composite. The GPU
    // work a `drawImage` schedules is not in it, and no web API exposes that
    // without a timer query. `tickGap` is the honest end-to-end number - it
    // includes React, garbage collection and the browser's own compositing,
    // because it is simply how long the browser took to call us back.
    expect(timing(snap, 'draw')!.p95).toBeLessThan(16.6);
    expect(counter(snap, 'droppedFrames')?.mean ?? 0).toBeLessThan(2);
    expect(gap.mean).toBeLessThan(20);
    expect(gap.p95).toBeLessThan(34);
  } else {
    // No GPU, so 60 fps is off the table and asserting it would only measure
    // the runner. What is still worth catching is a collapse: a CI runner on
    // SwiftShader measured `draw` p95 at 186-230 ms and `tickGap` p95 at
    // 196-247 ms across three runs, so these bounds sit at roughly three times
    // the worst of those. They fail on an order of magnitude, not on drift.
    expect(timing(snap, 'draw')!.p95).toBeLessThan(750);
    expect(gap.p95).toBeLessThan(800);
  }
});

test('the visible-clip lookup stays free on a heavily cut timeline', async ({ page }) => {
  await importClip(page);

  // Razor the clip into many pieces: the lookup used to scan and sort every
  // clip of every track on every frame.
  await page.keyboard.press('Home');
  for (let i = 1; i < 24; i++) {
    for (let f = 0; f < 3; f++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('s');
  }
  await expect(page.locator('[data-clip-id]')).toHaveCount(24);

  const gpu = await renderPath(page);
  await setProbe(page, true);
  await playFor(page, 2500);

  const snap = await snapshot(page);
  report('preview, 24 clips', snap);

  // What this test is named after is the LOOKUP, and the lookup is asserted the
  // same way everywhere: 24 clips must cost what one clip costs. The absolute
  // half of that only means something on a GPU - a CI runner on SwiftShader
  // measured 1.6-2.0 dropped frames per drawn frame here, and the identical
  // 1.0-2.8 on the single-clip test above, which is the point: the cut did not
  // add anything, the rasterizer did.
  const dropped = counter(snap, 'droppedFrames');
  const draw = timing(snap, 'draw')!;

  if (gpu.hardware) {
    expect(dropped?.mean ?? 0).toBeLessThan(1.5);
    expect(draw.mean).toBeLessThan(10);
  } else {
    expect(dropped?.mean ?? 0).toBeLessThan(8);
    expect(draw.mean).toBeLessThan(20);
  }
});

test('the scopes readback stays off the frame budget', async ({ page }) => {
  // Feeding the video scopes means reading pixels back from the GPU every
  // frame, which is the one operation in the loop that forces the CPU to wait
  // for the GPU. Whether that is a real cost or a rounding error is exactly the
  // kind of question this suite exists to answer rather than argue about.
  await importClip(page);

  const url = await appModuleUrl(page, STORE_MODULE);
  const measure = async (scopes: boolean) => {
    await page.evaluate(
      async ({ mod, on }) => {
        const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
        (useStore.getState() as unknown as { setScopesMode: (m: string) => void }).setScopesMode(
          on ? 'waveform' : 'off',
        );
      },
      { mod: url, on: scopes },
    );
    await setProbe(page, true);
    await playFor(page, 2000);
    return snapshot(page);
  };

  const gpu = await renderPath(page);
  const without = await measure(false);
  const withScopes = await measure(true);
  report('preview, scopes off', without);
  report('preview, scopes on', withScopes);

  const scopeTiming = timing(withScopes, 'scopes');
  expect(scopeTiming).toBeDefined();
  // Measured before the rate cap: 1.10 ms per frame, which was 80% of
  // everything else the loop did put together. Capped at 20 Hz it is 0.10 ms.
  // The bound below is an order of magnitude above the measurement and an order
  // of magnitude below the cost it replaced.
  //
  // A readback is the one operation in the loop that waits on the compositor,
  // so it is also the one whose absolute cost is least transferable: a CI runner
  // on SwiftShader measured 0.4-2.0 ms for the same capped work. The software
  // bound sits three times above the worst of those, and the relative bounds
  // below - which are what the test is really asserting - run everywhere.
  expect(scopeTiming!.mean).toBeLessThan(gpu.hardware ? 0.5 : 6);

  // Opening the scopes must not multiply the frame's cost. Before the cap it
  // multiplied it by nearly five.
  const on = timing(withScopes, 'frame')!;
  const off = timing(without, 'frame')!;
  expect(on.mean).toBeLessThan(off.mean * 3 + 0.2);
  // The absolute half of that claim only holds where the composite it is added
  // to is a GPU composite. A CI runner measured 11.3 ms here against the same
  // 16.6 ms bound, which is a flake waiting for a busy runner rather than a
  // budget; the relative bound above is what the test is really asserting.
  expect(on.p95).toBeLessThan(gpu.hardware ? 16.6 : 50);
});

test('an open inspector does not cost the render loop its budget', async ({ page }) => {
  // The store writes the playhead position on every rendered frame, and every
  // subscribed selector in the application re-runs on every write. With the
  // inspector open, several of its panels read that value directly. Whether
  // that is a real cost - a React reconciliation inside the frame budget - or a
  // handful of property comparisons is a question of measurement.
  await importClip(page);
  const url = await appModuleUrl(page, STORE_MODULE);

  const withInspector = async (open: boolean) => {
    await page.evaluate(
      async ({ mod, on }) => {
        const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
        const s = useStore.getState() as unknown as {
          project: { tracks: { clips: { id: string }[] }[] };
          selectClip: (id: string) => void;
          setInspectorOpen: (v: boolean) => void;
        };
        const clip = s.project.tracks.flatMap((t) => t.clips)[0];
        if (clip) s.selectClip(clip.id);
        s.setInspectorOpen(on);
      },
      { mod: url, on: open },
    );
    await setProbe(page, true);
    await playFor(page, 2500);
    return snapshot(page);
  };

  const gpu = await renderPath(page);
  const closed = await withInspector(false);
  const open = await withInspector(true);
  report('preview, inspector closed', closed);
  report('preview, inspector open', open);

  // `tickGap` is the only channel that sees React at all: it is the interval
  // between two calls of the loop, so anything the main thread does between
  // them - reconciliation, layout, garbage collection - lands in it.
  const gapClosed = timing(closed, 'tickGap')!;
  const gapOpen = timing(open, 'tickGap')!;
  console.log(
    `  tickGap p95: closed ${gapClosed.p95.toFixed(2)} ms, open ${gapOpen.p95.toFixed(2)} ms`,
  );

  // The frame's own work is unchanged: the inspector draws nothing.
  expect(timing(open, 'draw')!.mean).toBeLessThan(timing(closed, 'draw')!.mean * 2 + 0.1);

  // What the test is actually named after: opening the inspector must not cost
  // the loop anything the loop was not already paying. Stated against the same
  // machine's closed-inspector run rather than against a constant, because the
  // interval between two rAF callbacks is a property of the host - a CI runner
  // idles at a 30-50 ms p95 with nothing open at all, so a fixed bound there
  // fails on the runner's own cadence and says nothing about the inspector.
  expect(gapOpen.p95).toBeLessThan(gapClosed.p95 * 1.5 + 8);
  // And with a GPU, that interval is inside a frame in absolute terms too.
  if (gpu.hardware) expect(gapOpen.p95).toBeLessThan(34);
});

test('a heavily cut timeline stays responsive to edits', async ({ page }) => {
  // The timeline renders one element per clip, unvirtualized. Whether that is a
  // problem is a question about how long an EDIT takes on a long cut, not about
  // how many nodes exist - so that is what is measured: the round trip from a
  // store action to the browser having laid the result out.
  await importClip(page);
  const url = await appModuleUrl(page, STORE_MODULE);

  const editLatency = async (clips: number): Promise<{ ms: number; nodes: number }> =>
    page.evaluate(
      async ({ mod, count }) => {
        const { useStore } = (await import(mod)) as {
          useStore: { getState: () => never; setState: (p: unknown) => void };
        };
        const state = useStore.getState() as unknown as {
          project: { tracks: { id: string; clips: Record<string, unknown>[] }[] };
        };
        const track = state.project.tracks.find((t) => t.clips.length > 0)!;
        const seed = track.clips[0]!;
        const laid = Array.from({ length: count }, (_, i) => ({
          ...seed,
          id: `lat-clip-${i}`,
          timelineStartMs: i * 3000,
        }));
        useStore.setState({
          project: {
            ...state.project,
            tracks: state.project.tracks.map((t) => (t.id === track.id ? { ...t, clips: laid } : t)),
          },
        });
        const g = globalThis as unknown as {
          requestAnimationFrame: (cb: () => void) => number;
          document: { querySelectorAll(sel: string): { length: number } };
        };
        const nextFrame = () => new Promise((r) => g.requestAnimationFrame(() => r(null)));
        await nextFrame();
        await nextFrame();

        // Twenty selections, each a store commit that re-renders the lane.
        const select = useStore.getState() as unknown as { selectClip: (id: string) => void };
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) {
          select.selectClip(`lat-clip-${i % count}`);
          await nextFrame();
        }
        const ms = (performance.now() - t0) / 20;
        return { ms, nodes: g.document.querySelectorAll('[data-clip-id]').length };
      },
      { mod: url, count: clips },
    );

  const small = await editLatency(20);
  const large = await editLatency(300);
  console.log(
    `\n--- timeline edit latency ---\n` +
      `  20 clips:  ${small.ms.toFixed(2)} ms/edit, ${small.nodes} rendered\n` +
      `  300 clips: ${large.ms.toFixed(2)} ms/edit, ${large.nodes} rendered`,
  );

  // Fifteen times the clips must not make an edit fifteen times slower. The
  // bound is loose because each iteration waits a frame, so the floor is the
  // display interval, not the work.
  expect(large.ms).toBeLessThan(small.ms * 3 + 8);
});
