import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDepUrl, appModuleUrl } from './appModule';

/**
 * The exported soundtrack is continuous, and building it does not need the
 * whole timeline in memory.
 *
 * The mix used to be rendered in one `OfflineAudioContext` covering the entire
 * export - one contiguous Float32 allocation, 690 MB for an hour of stereo
 * 48 kHz, built before the first video frame and held until the last. It is now
 * pulled from the worker a few seconds at a time.
 *
 * Slicing a mix is exactly the kind of change that sounds free and produces a
 * click every five seconds, so this exports a timeline several slices long and
 * decodes the result: no dropout anywhere, and in particular none at the slice
 * boundaries, which are the only places a chunked renderer can betray itself.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_WAV = path.join(FIXTURES, 'tone.wav');

const STORE_MODULE = '/src/store/store.ts';
const EXPORTER_MODULE = '/src/export/exporter.ts';

/** Slice length the worker pulls, in seconds (see AUDIO_CHUNK_FRAMES). */
const CHUNK_SEC = 5;
/** Long enough to cross three slice boundaries. */
const TARGET_SEC = 17;
/** Envelope resolution: fine enough that a lost sample moves a window. */
const WINDOW_SEC = 0.25;

test('a soundtrack longer than one mix slice comes back continuous', async ({ page }) => {
  test.setTimeout(180_000);

  // No picker: the render lands in scratch storage, where the page can decode
  // it without moving the file through the harness.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_WAV);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  const storeUrl = await appModuleUrl(page, STORE_MODULE);

  // Repeat the tone end to end until the timeline is long enough to need
  // several slices. Built through the store rather than the UI: what is under
  // test is the mix, not the paste command.
  const layout = await page.evaluate(
    async ({ mod, target }) => {
      const { useStore } = (await import(mod)) as {
        useStore: { getState: () => never; setState: (p: unknown) => void };
      };
      const state = useStore.getState() as unknown as {
        project: {
          tracks: {
            id: string;
            kind: string;
            clips: { id: string; timelineStartMs: number; sourceInMs: number; sourceOutMs: number; speed: number }[];
          }[];
        };
      };
      const track = state.project.tracks.find((t) => t.clips.length > 0)!;
      const seed = track.clips[0]!;
      const durMs = (seed.sourceOutMs - seed.sourceInMs) / seed.speed;
      const copies = Math.ceil((target * 1000) / durMs);
      const clips = Array.from({ length: copies }, (_, i) => ({
        ...seed,
        id: `audio-clip-${i}`,
        timelineStartMs: Math.round(i * durMs),
      }));
      useStore.setState({
        project: {
          ...state.project,
          tracks: state.project.tracks.map((t) => (t.id === track.id ? { ...t, clips } : t)),
        },
      });
      return { totalSec: (copies * durMs) / 1000, clipMs: durMs };
    },
    { mod: storeUrl, target: TARGET_SEC },
  );
  const timelineSec = layout.totalSec;
  expect(timelineSec).toBeGreaterThan(CHUNK_SEC * 3);

  // Export straight through the exporter module with an MP3 preset: the audio
  // path with nothing else in it.
  const exporterUrl = await appModuleUrl(page, EXPORTER_MODULE);
  const exported = await page.evaluate(
    async ({ exporter, store }) => {
      const { startExport } = (await import(exporter)) as {
        startExport: (
          project: unknown,
          assets: unknown,
          preset: unknown,
          onProgress: (v: number) => void,
        ) => { promise: Promise<{ blob: Blob | null; filename: string }> };
      };
      const { useStore } = (await import(store)) as { useStore: { getState: () => never } };
      const s = useStore.getState() as unknown as { project: unknown; assets: unknown };
      const preset = {
        id: 'test-mp3',
        group: 'audio',
        labelKey: 'export.preset.mp3.label',
        descriptionKey: 'export.preset.audio.description',
        qualityKey: 'export.quality.mp3_high',
        kind: 'mp3',
        audioBitrate: 192_000,
      };
      try {
        const { blob } = await startExport(s.project, s.assets, preset, () => {}).promise;
        return { ok: true, hasBlob: !!blob };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { exporter: exporterUrl, store: storeUrl },
  );
  expect(exported.error ?? null).toBeNull();
  expect(exported.ok).toBe(true);

  // Decode the scratch file and measure the envelope in 250 ms windows.
  const mediabunny = await appDepUrl(page, 'mediabunny');
  const analysis = await page.evaluate(
    async ({ dep, windowSec }) => {
      type Dir = {
        getDirectoryHandle(name: string): Promise<Dir>;
        getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
        keys(): AsyncIterable<string>;
      };
      const g = globalThis as unknown as {
        navigator: { storage: { getDirectory(): Promise<Dir> } };
      };
      const dir = await (await g.navigator.storage.getDirectory()).getDirectoryHandle('exports');
      let name: string | null = null;
      for await (const key of dir.keys()) name = key;
      if (!name) return { error: 'no scratch file' };
      const blob = await (await dir.getFileHandle(name)).getFile();

      // Decode with the browser's own decoder: what matters is what a player
      // hears, not what our encoder thinks it wrote.
      const bytes = await blob.arrayBuffer();
      const ctx = new (
        globalThis as unknown as {
          AudioContext: new () => {
            decodeAudioData(b: ArrayBuffer): Promise<{
              duration: number;
              sampleRate: number;
              getChannelData(i: number): Float32Array;
            }>;
          };
        }
      ).AudioContext();
      const decoded = await ctx.decodeAudioData(bytes);
      const data = decoded.getChannelData(0);
      const rate = decoded.sampleRate;
      const per = Math.round(rate * windowSec);
      const rms: number[] = [];
      for (let i = 0; i + per <= data.length; i += per) {
        let sum = 0;
        for (let j = i; j < i + per; j++) sum += data[j]! * data[j]!;
        rms.push(Math.sqrt(sum / per));
      }
      void dep;
      return { duration: decoded.duration, rate, rms };
    },
    { dep: mediabunny, windowSec: WINDOW_SEC },
  );

  expect(analysis.error ?? null).toBeNull();
  const rms = analysis.rms!;

  // The file is as long as the timeline (one window of slack for the encoder's
  // priming and its final partial frame).
  expect(analysis.duration!).toBeGreaterThan(timelineSec - 0.5);

  // Every window carries signal. A slice that failed to render, or a boundary
  // that dropped samples, shows up as a hole here.
  const loud = rms.filter((v) => v > 0.001).length;
  expect(loud / rms.length).toBeGreaterThan(0.9);

  // The strong assertion, and the one this test exists for.
  //
  // The timeline is the SAME clip repeated end to end, so the envelope must be
  // exactly periodic at the clip length. A slice boundary that dropped a
  // sample, repeated one, or restarted a source at the wrong offset breaks that
  // periodicity - and the boundaries fall inside clips, not between them, so
  // there is nowhere for such an error to hide.
  const period = Math.round(layout.clipMs / (WINDOW_SEC * 1000));
  expect(period).toBeGreaterThan(1);
  const boundaryWindow = Math.floor(CHUNK_SEC / WINDOW_SEC);
  expect(boundaryWindow).toBeLessThan(rms.length);

  const deviations = rms
    .map((v, i) => (i < period ? 0 : Math.abs(v - rms[i % period]!) / Math.max(rms[i % period]!, 1e-6)))
    .map((d, i) => ({ i, d }))
    .filter(({ d }) => d > 0.05);
  expect(deviations).toEqual([]);
});
