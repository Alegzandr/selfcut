import { test, expect } from './test';
import { appDepUrl, appModuleUrl } from './appModule';

/**
 * Does slicing a render into shorter segments still cost bitrate accuracy?
 *
 * It used to, and `MIN_SEGMENT_SECONDS` stood at fifteen seconds because of it:
 * eight slices of a one-minute render produced a file half the size of the
 * serial one, no encoder having run long enough to settle at the target. That
 * measurement predates the export declaring its cadence on the track, which is
 * the input rate control was actually missing - so it was worth re-taking
 * before the floor it justified went on being treated as a fact. It did not
 * survive the re-take, and the floor is now four seconds.
 *
 * Encoder only: no decode, no compositing, no workers. The question is purely
 * what a `VideoEncoder` does with a short run.
 *
 * A `probe*` spec, so it is out of the default suite: it encodes ten minutes of
 * 1080p60 across thirty runs and would hold the machine's one hardware encoder
 * for the whole of it. Run it by hand when the floor is in question:
 *
 *   npx playwright test e2e/probeSliceRate.spec.ts
 */

const TOTAL_SECONDS = 30;
const MEDIABUNNY_MAIN = '/src/media/mediabunnyMain.ts';

test('bitrate accuracy against slice length', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/app/');
  // Nothing has pulled mediabunny into the graph yet on a page that has not
  // imported a file; this is the app's own entry point to it.
  // The specifier goes through as an argument, not a literal: a bare
  // `import('/src/…')` is a Vite path that `tsc` cannot resolve.
  await page.evaluate((mod) => import(mod), await appModuleUrl(page, MEDIABUNNY_MAIN));
  const mb = await appDepUrl(page, 'mediabunny');

  const rows = await page.evaluate(
    async ({ mod, totalSeconds }) => {
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource } = (await import(mod)) as {
        Output: new (o: unknown) => {
          addVideoTrack: (s: unknown, m?: unknown) => void;
          start: () => Promise<void>;
          finalize: () => Promise<void>;
          target: { buffer: ArrayBuffer };
        };
        Mp4OutputFormat: new () => unknown;
        BufferTarget: new () => unknown;
        CanvasSource: new (c: unknown, o: unknown) => {
          add: (t: number, d: number) => Promise<void>;
          close: () => void;
        };
      };

      const W = 1920;
      const H = 1080;
      const FPS = 60;
      const BITRATE = 24_000_000;

      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d')!;
      // Content the encoder cannot cheat on: every frame differs everywhere.
      const paint = (n: number): void => {
        const img = ctx.createImageData(W, 64);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = (Math.imul(i + n * 7919, 2654435761) >>> 24) & 0xff;
          img.data[i] = v;
          img.data[i + 1] = (v * 3) & 0xff;
          img.data[i + 2] = (v * 7) & 0xff;
          img.data[i + 3] = 255;
        }
        for (let y = 0; y < H; y += 64) ctx.putImageData(img, 0, y);
        ctx.fillStyle = `hsl(${n % 360} 80% 50%)`;
        ctx.fillRect((n * 13) % (W - 300), (n * 7) % (H - 300), 300, 300);
      };

      /** Encode `frames` frames as one standalone file; return its byte length. */
      const encodeSlice = async (firstFrame: number, frames: number, declare: boolean): Promise<number> => {
        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const source = new CanvasSource(canvas, {
          codec: 'avc',
          bitrate: BITRATE,
          latencyMode: 'quality',
          keyFrameInterval: 2,
        });
        output.addVideoTrack(source, declare ? { frameRate: FPS } : undefined);
        await output.start();
        for (let i = 0; i < frames; i++) {
          paint(firstFrame + i);
          await source.add(i / FPS, 1 / FPS);
        }
        source.close();
        await output.finalize();
        return output.target.buffer.byteLength;
      };

      const totalFrames = totalSeconds * FPS;
      const out: {
        sliceSeconds: number;
        slices: number;
        declared: number;
        undeclared: number;
      }[] = [];
      for (const sliceSeconds of [30, 15, 8, 4, 2]) {
        const per = sliceSeconds * FPS;
        const slices = Math.ceil(totalFrames / per);
        const sizes: Record<'declared' | 'undeclared', number> = { declared: 0, undeclared: 0 };
        for (const mode of ['declared', 'undeclared'] as const) {
          let bytes = 0;
          for (let s = 0; s < slices; s++) {
            const first = s * per;
            bytes += await encodeSlice(first, Math.min(per, totalFrames - first), mode === 'declared');
          }
          sizes[mode] = bytes;
        }
        out.push({ sliceSeconds, slices, declared: sizes.declared, undeclared: sizes.undeclared });
      }
      return out;
    },
    { mod: mb, totalSeconds: TOTAL_SECONDS },
  );

  const mbps = (bytes: number): number => (bytes * 8) / TOTAL_SECONDS / 1e6;
  const lines = [
    `\n--- ${TOTAL_SECONDS}s of 1080p60, asked 24.0 Mbps, cut into slices ---`,
    '  slice   n   cadence declared        cadence absent',
  ];
  for (const r of rows) {
    lines.push(
      `  ${String(r.sliceSeconds).padStart(3)}s ${String(r.slices).padStart(3)}   ` +
        `${mbps(r.declared).toFixed(1).padStart(6)} Mbps (${((mbps(r.declared) / 24) * 100).toFixed(0).padStart(3)}%)   ` +
        `${mbps(r.undeclared).toFixed(1).padStart(6)} Mbps (${((mbps(r.undeclared) / 24) * 100).toFixed(0).padStart(3)}%)`,
    );
  }
  console.log(lines.join('\n'));

  // The claim MIN_SEGMENT_SECONDS now rests on: with the cadence declared, a
  // slice's length does not decide its bitrate. Loose bounds on purpose - the
  // point is that four-second slices behave like thirty-second ones, not that
  // any of them hits 24.0 Mbps exactly.
  for (const r of rows) {
    expect(mbps(r.declared), `${r.sliceSeconds}s slices`).toBeGreaterThan(24 * 0.85);
    expect(mbps(r.declared), `${r.sliceSeconds}s slices`).toBeLessThan(24 * 1.25);
  }
});
