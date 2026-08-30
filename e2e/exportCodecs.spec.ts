import { test, expect } from './test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDepUrl, appModuleUrl } from './appModule';

/**
 * The modern-codec presets encode with the codec they name, or fall back to
 * H.264 - and never fail.
 *
 * A codec choice is a preference about file size, so it must never be a way to
 * make an export impossible: a browser without an HEVC or AV1 encoder has to
 * produce an H.264 file rather than an error. That fallback is exactly the kind
 * of path that is written once and never exercised, so it is exercised here on
 * whatever the test browser happens to support.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

const EXPORTER_MODULE = '/src/export/exporter.ts';
const PRESETS_MODULE = '/src/export/presets.ts';
const STORE_MODULE = '/src/store/store.ts';

/** Codec-string prefixes each family is muxed under in an MP4. */
const FAMILIES: Record<string, RegExp> = {
  avc: /^avc1|^avc3/,
  hevc: /^hev1|^hvc1/,
  av1: /^av01/,
};

for (const wanted of ['hevc', 'av1'] as const) {
  test(`the ${wanted} preset produces ${wanted}, or H.264, but always a file`, async ({ page }) => {
    test.setTimeout(240_000);

    await page.addInitScript(() => {
      delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });

    await page.goto('/app/');
    await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
    await expect(page.locator('[data-clip-id]')).toHaveCount(1);

    const exporterUrl = await appModuleUrl(page, EXPORTER_MODULE);
    const presetsUrl = await appModuleUrl(page, PRESETS_MODULE);
    const storeUrl = await appModuleUrl(page, STORE_MODULE);
    const mediabunny = await appDepUrl(page, 'mediabunny');

    const result = await page.evaluate(
      async ({ exporter, presets, store, dep, codec }) => {
        const { startExport } = (await import(exporter)) as {
          startExport: (
            p: unknown,
            a: unknown,
            preset: unknown,
            onProgress: (v: number) => void,
          ) => { promise: Promise<{ blob: Blob | null }> };
        };
        const { PRESETS } = (await import(presets)) as {
          PRESETS: { id: string; kind: string; aspect?: string; codec?: string }[];
        };
        const { useStore } = (await import(store)) as { useStore: { getState: () => never } };
        const s = useStore.getState() as unknown as { project: unknown; assets: unknown };

        const preset = PRESETS.find((p) => p.codec === codec && p.aspect === '16:9');
        if (!preset) return { error: `no ${codec} preset for 16:9` };

        type Dir = {
          getDirectoryHandle(name: string): Promise<Dir>;
          getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
          removeEntry(name: string): Promise<void>;
          keys(): AsyncIterable<string>;
        };
        const g = globalThis as unknown as {
          navigator: { storage: { getDirectory(): Promise<Dir> } };
        };
        const exports = await (await g.navigator.storage.getDirectory()).getDirectoryHandle(
          'exports',
        );
        for await (const key of exports.keys()) await exports.removeEntry(key);

        try {
          await startExport(s.project, s.assets, preset, () => {}).promise;
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }

        let name: string | null = null;
        for await (const key of exports.keys()) name = key;
        if (!name) return { error: 'no scratch file' };
        const blob = await (await exports.getFileHandle(name)).getFile();

        const { Input, ALL_FORMATS, BlobSource } = (await import(dep)) as {
          Input: new (o: { formats: unknown; source: unknown }) => {
            getPrimaryVideoTrack(): Promise<{ getCodecParameterString(): Promise<string | null> } | null>;
            computeDuration(): Promise<number>;
            dispose(): void;
          };
          ALL_FORMATS: unknown;
          BlobSource: new (b: Blob) => unknown;
        };
        const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
        const track = await input.getPrimaryVideoTrack();
        if (!track) return { error: 'no video track in the export' };
        const codecString = await track.getCodecParameterString();
        const duration = await input.computeDuration();
        input.dispose();
        return { codecString, duration, bytes: blob.size };
      },
      {
        exporter: exporterUrl,
        presets: presetsUrl,
        store: storeUrl,
        dep: mediabunny,
        codec: wanted,
      },
    );

    expect(result.error ?? null).toBeNull();
    const codecString = result.codecString ?? '';
    console.log(`  ${wanted} preset -> ${codecString} (${(result.bytes! / 1024).toFixed(0)} KB)`);

    // Either the codec asked for, or the fallback. Never anything else, and
    // never a missing track.
    const isWanted = FAMILIES[wanted]!.test(codecString);
    const isFallback = FAMILIES.avc!.test(codecString);
    expect(isWanted || isFallback).toBe(true);

    // A real file with real content, whichever branch was taken.
    expect(result.duration!).toBeGreaterThan(0.5);
    expect(result.bytes!).toBeGreaterThan(1000);
  });
}
