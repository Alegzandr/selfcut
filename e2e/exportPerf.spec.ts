import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * Where an export's time actually goes.
 *
 * The claim this suite exists to settle is that the render loop is starved: one
 * worker, one encoder, one frame of overlap, so a machine with sixteen cores
 * spends the render waiting. Whether that is true is a matter of which of
 * `decode`, `composite` and `encodeWait` dominates, and how much of the wall
 * clock the three of them account for between them.
 *
 * So this measures rather than argues, and prints the breakdown on every run.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

const PROBE_MODULE = '/src/perf/probe.ts';
const EXPORTER_MODULE = '/src/export/exporter.ts';
const STORE_MODULE = '/src/store/store.ts';

interface ChannelStats {
  name: string;
  mean: number;
  p95: number;
  max: number;
  n: number;
}
interface Snapshot {
  timings: ChannelStats[];
  counters: ChannelStats[];
  frames: number;
  workers?: number;
}

test('an export spends its time where the instrumentation says it does', async ({ page }) => {
  test.setTimeout(240_000);

  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  // Repeat the clip until the render is long enough that the fixed costs -
  // booting the worker, configuring the encoder, finalizing the container - are
  // not what the throughput number is measuring.
  const storeSetup = await appModuleUrl(page, STORE_MODULE);
  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: { getState: () => never; setState: (p: unknown) => void };
    };
    const state = useStore.getState() as unknown as {
      project: { tracks: { id: string; clips: Record<string, unknown>[] }[] };
    };
    const track = state.project.tracks.find((t) => t.clips.length > 0)!;
    const seed = track.clips[0]! as { sourceInMs: number; sourceOutMs: number; speed: number };
    const durMs = (seed.sourceOutMs - seed.sourceInMs) / seed.speed;
    const clips = Array.from({ length: 10 }, (_, i) => ({
      ...seed,
      id: `perf-clip-${i}`,
      timelineStartMs: Math.round(i * durMs),
    }));
    useStore.setState({
      project: {
        ...state.project,
        tracks: state.project.tracks.map((t) => (t.id === track.id ? { ...t, clips } : t)),
      },
    });
  }, storeSetup);

  // The main thread's probe has to be on: it is what sets `measure` on the
  // export request, which is what arms the worker's own probe.
  const probeUrl = await appModuleUrl(page, PROBE_MODULE);
  await page.evaluate(async (mod) => {
    const { setPerfEnabled } = (await import(mod)) as { setPerfEnabled: (v: boolean) => void };
    setPerfEnabled(true);
  }, probeUrl);

  const exporterUrl = await appModuleUrl(page, EXPORTER_MODULE);
  const storeUrl = await appModuleUrl(page, STORE_MODULE);

  const result = await page.evaluate(
    async ({ exporter, store }) => {
      const { startExport, lastExportPerf } = (await import(exporter)) as {
        startExport: (
          project: unknown,
          assets: unknown,
          preset: unknown,
          onProgress: (v: number) => void,
        ) => { promise: Promise<{ blob: Blob | null }> };
        lastExportPerf: () => Snapshot | null;
      };
      const { useStore } = (await import(store)) as { useStore: { getState: () => never } };
      const s = useStore.getState() as unknown as { project: unknown; assets: unknown };
      const preset = {
        id: 'test-1080p',
        group: 'social',
        labelKey: 'export.preset.mp3.label',
        descriptionKey: 'export.preset.audio.description',
        qualityKey: 'export.quality.mp3_high',
        kind: 'mp4',
        aspect: '16:9',
        width: 1920,
        height: 1080,
        fps: 30,
        fpsMode: 'fixed',
        videoBitrate: 8_000_000,
        audioBitrate: 192_000,
      };
      const t0 = performance.now();
      try {
        await startExport(s.project, s.assets, preset, () => {}).promise;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      return { wallMs: performance.now() - t0, snapshot: lastExportPerf() };
    },
    { exporter: exporterUrl, store: storeUrl },
  );

  expect(result.error ?? null).toBeNull();
  const snap = result.snapshot!;
  expect(snap).not.toBeNull();
  expect(snap.frames).toBeGreaterThan(10);

  const of = (name: string): ChannelStats | undefined => snap.timings.find((t) => t.name === name);
  const frame = of('frame')!;
  const decode = of('decode');
  const composite = of('composite');
  const encodeWait = of('encodeWait');

  const lines = [
    `\n--- export: ${snap.frames} frames in ${result.wallMs!.toFixed(0)} ms ` +
      `(${((snap.frames / result.wallMs!) * 1000).toFixed(1)} fps, ${snap.workers ?? 1} workers) ---`,
  ];
  for (const t of snap.timings) {
    const share = frame.mean > 0 ? ((t.mean / frame.mean) * 100).toFixed(0) : '--';
    lines.push(`  ${t.name.padEnd(12)} mean ${t.mean.toFixed(3)} ms  p95 ${t.p95.toFixed(2)}  ${share}% of a frame`);
  }
  console.log(lines.join('\n'));

  // Compositing must not be the dominant cost of an export. If it ever became
  // so, the answer would be a GPU compositor, and this is the number that would
  // say so.
  expect(composite!.mean).toBeLessThan(frame.mean * 0.7);

  // Both of the other two exist and are measured, so the breakdown printed
  // above is complete rather than a single bar labelled "frame".
  expect(decode).toBeDefined();
  expect(encodeWait).toBeDefined();
});

/** Report helper kept out of the assertion path so a failure prints the numbers. */
export async function exportBreakdown(page: Page): Promise<Snapshot | null> {
  const exporterUrl = await appModuleUrl(page, EXPORTER_MODULE);
  return page.evaluate(async (mod) => {
    const { lastExportPerf } = (await import(mod)) as { lastExportPerf: () => Snapshot | null };
    return lastExportPerf();
  }, exporterUrl);
}
