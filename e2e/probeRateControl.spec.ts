import { test, expect } from '@playwright/test';
import { appDepUrl, appModuleUrl } from './appModule';
import { writeFileSync } from 'node:fs';

/**
 * Does the browser's H.264 encoder actually spend the bitrate an export asks
 * for at 120 fps?
 *
 * The question came from a real export: "120 fps · 1080p" resolves to 38.4 Mbps
 * (see `videoBitrateForFps`), and the file that came out of it was 10.2 Mbps -
 * a quarter of the target, visibly blocky in the dark areas of a screen capture.
 * Nothing between the export sheet and `VideoEncoder.configure` lowers the
 * figure, so either the encoder undershoots the target or the cadence declared
 * on the track changes what the target means.
 *
 * This re-encodes a real capture through the same geometry, cadence and codec
 * the export uses, once per rate control worth comparing, and writes each
 * result next to the source so the pictures can be compared as well as the
 * sizes. It asserts nothing about which one wins: it is an instrument.
 *
 *   PROBE=1 RC_SOURCE=D:/clips/capture.mkv npx playwright test e2e/probeRateControl.spec.ts
 *
 * `RC_OUT` (a directory) takes the encoded files; without it only the numbers
 * are reported.
 */

const SOURCE = process.env.RC_SOURCE;
const OUT_DIR = process.env.RC_OUT;
/** How much of the source to re-encode. Enough to let rate control settle. */
const SECONDS = Number(process.env.RC_SECONDS ?? 5);

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 120;
/** What "120 fps · 1080p" resolves to for a 16:9 project. */
const BITRATE = 38_400_000;

interface Variant {
  label: string;
  /** Declare the cadence on the video track, as the export does today. */
  frameRate: boolean;
  bitrate: number;
  bitrateMode?: 'constant' | 'variable';
  hardwareAcceleration?: 'no-preference' | 'prefer-software';
  /** Encode at a fixed quantizer instead of to a bitrate target. */
  quantizer?: number;
}

const VARIANTS: Variant[] = [
  { label: 'today (vbr, fps declared)', frameRate: true, bitrate: BITRATE },
  { label: 'cbr, fps declared', frameRate: true, bitrate: BITRATE, bitrateMode: 'constant' },
  { label: 'vbr, no fps declared', frameRate: false, bitrate: BITRATE },
  { label: 'cbr, no fps declared', frameRate: false, bitrate: BITRATE, bitrateMode: 'constant' },
  { label: 'vbr, fps declared, 4x ask', frameRate: true, bitrate: BITRATE * 4 },
  {
    label: 'software vbr, fps declared',
    frameRate: true,
    bitrate: BITRATE,
    hardwareAcceleration: 'prefer-software',
  },
  {
    label: 'software cbr, fps declared',
    frameRate: true,
    bitrate: BITRATE,
    bitrateMode: 'constant',
    hardwareAcceleration: 'prefer-software',
  },
  { label: 'quantizer 18', frameRate: true, bitrate: BITRATE, quantizer: 18 },
  { label: 'quantizer 22', frameRate: true, bitrate: BITRATE, quantizer: 22 },
  { label: 'quantizer 26', frameRate: true, bitrate: BITRATE, quantizer: 26 },
];

interface RunResult {
  label: string;
  bytes: number;
  packets: number;
  mbps: number;
  seconds: number;
}

test('rate control at 1080p120 on a real capture', async ({ page }, testInfo) => {
  test.skip(!SOURCE, 'set RC_SOURCE to a capture to re-encode');
  test.setTimeout(900_000);

  await page.goto('/app/');
  // mediabunny is deferred until the app needs it, and `appDepUrl` can only
  // find what the page has already loaded: pull the app's own entry point in
  // first so the dependency lands in the module graph.
  await page.evaluate(
    (url) => import(/* @vite-ignore */ url).then(() => undefined),
    await appModuleUrl(page, '/src/media/mediabunnyMain.ts'),
  );
  const mediabunnyUrl = await appDepUrl(page, 'mediabunny');

  // The capture reaches the page as a File through an input of the spec's own,
  // rather than the app's importer: nothing here wants a project, only frames.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'rc-source';
    document.body.append(input);
  });
  await page.setInputFiles('#rc-source', SOURCE!);

  const results = await page.evaluate(
    async ({ mediabunnyUrl, variants, WIDTH, HEIGHT, FPS, SECONDS, wantFiles }) => {
      const mb = (await import(/* @vite-ignore */ mediabunnyUrl)) as typeof import('mediabunny');
      const file = (document.getElementById('rc-source') as HTMLInputElement).files![0];

      const openSink = async () => {
        const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error('no video track in source');
        return new mb.VideoSampleSink(track);
      };

      const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
      const ctx = canvas.getContext('2d')!;
      // Base64 rather than a number array: a 40 MB file crossing the bridge as
      // 40 million JS numbers is what makes the test runner run out of heap.
      const toBase64 = (data: Uint8Array): string => {
        let binary = '';
        for (let i = 0; i < data.length; i += 0x8000) {
          binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      };
      const out: { result: RunResult; bytes?: string }[] = [];
      const wanted = Math.round(SECONDS * FPS);

      // Decoded once per variant rather than held as bitmaps: eight seconds of
      // 1440p120 is a thousand frames, and keeping them is gigabytes. Every
      // variant walks the same samples in the same order, so they still encode
      // the same pictures.
      for (const variant of variants) {
        const sink = await openSink();
        const output = new mb.Output({
          format: new mb.Mp4OutputFormat(),
          target: new mb.BufferTarget(),
        });
        const source = new mb.CanvasSource(canvas, {
          codec: 'avc',
          ...(variant.quantizer !== undefined
            ? { quality: new mb.Quality({ quantizer: variant.quantizer, bitrate: variant.bitrate }) }
            : { bitrate: variant.bitrate, bitrateMode: variant.bitrateMode }),
          latencyMode: 'quality',
          keyFrameInterval: 2,
          hardwareAcceleration: variant.hardwareAcceleration,
        });
        output.addVideoTrack(source, variant.frameRate ? { frameRate: FPS } : undefined);
        await output.start();
        let count = 0;
        for await (const sample of sink.samples(0, SECONDS)) {
          if (count >= wanted) {
            sample.close();
            break;
          }
          ctx.drawImage(sample.toCanvasImageSource(), 0, 0, WIDTH, HEIGHT);
          sample.close();
          await source.add(count / FPS, 1 / FPS);
          count++;
        }
        source.close();
        await output.finalize();
        const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer!;
        const seconds = count / FPS;
        out.push({
          result: {
            label: variant.label,
            bytes: buffer.byteLength,
            packets: count,
            mbps: (buffer.byteLength * 8) / seconds / 1e6,
            seconds,
          },
          ...(wantFiles ? { bytes: toBase64(new Uint8Array(buffer)) } : {}),
        });
      }
      return out.map((entry) => ({ result: entry.result, bytes: entry.bytes ?? null }));
    },
    { mediabunnyUrl, variants: VARIANTS, WIDTH, HEIGHT, FPS, SECONDS, wantFiles: !!OUT_DIR },
  );

  for (const [i, entry] of results.entries()) {
    const r = entry.result as RunResult;
    console.log(
      `${r.label.padEnd(28)} ${r.mbps.toFixed(1).padStart(7)} Mbps  ${r.packets} frames  ${(r.bytes / 1e6).toFixed(1)} MB`,
    );
    if (entry.bytes && OUT_DIR) {
      const path = `${OUT_DIR}/rc-${i}-${VARIANTS[i].label.replace(/[^a-z0-9]+/gi, '-')}.mp4`;
      writeFileSync(path, Buffer.from(entry.bytes as string, 'base64'));
      console.log(`  -> ${path}`);
    }
  }
  testInfo.attach('rate-control', { body: JSON.stringify(results.map((r) => r.result), null, 2), contentType: 'application/json' });
  expect(results.length).toBe(VARIANTS.length);
});
