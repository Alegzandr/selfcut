import { test, expect, type Page } from './test';
import { appModuleUrl } from './appModule';

/**
 * "Match volumes" brings every clip to the same level AS IT PLAYS.
 *
 * The balance used to measure each source file and set the fader from that,
 * which is right only when the file plays as it is. Three ordinary cases did
 * not, and each landed off the common level:
 * - a mono file is heard on both speakers: 3 dB louder than its file;
 * - a one-sided recording with "Mono" on is averaged into both: 3 dB quieter;
 * - a compressor after the fader answers a lift with less, plus its own
 *   make-up gain: several dB too loud, up to clipping.
 *
 * Each clip is checked here through the export's own mixer, over its own
 * span of the full cut.
 */

const SR = 48_000;

/** 24-bit PCM WAV of a 1 kHz tone, pulsed like speech, per-channel amplitudes. */
function wav(seconds: number, amps: number[]): Buffer {
  const channels = amps.length;
  const frames = Math.round(seconds * SR);
  const data = Buffer.alloc(frames * channels * 3);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / SR;
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t);
    const s = Math.sin(2 * Math.PI * 1000 * t) * envelope;
    for (const amp of amps) {
      const v = Math.round(Math.max(-1, Math.min(1, s * amp)) * 0x7fffff);
      data.writeIntLE(v, o, 3);
      o += 3;
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * channels * 3, 28);
  h.writeUInt16LE(channels * 3, 32);
  h.writeUInt16LE(24, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

type Clip = { id: string; name: string; startMs: number; endMs: number };

async function clips(page: Page): Promise<Clip[]> {
  const store = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(async (s) => {
    const { useStore } = (await import(s)) as {
      useStore: { getState: () => { project: { tracks: { clips: { id: string; assetId: string; timelineStartMs: number; sourceInMs: number; sourceOutMs: number; speed: number }[] }[] }; assets: Record<string, { file: File }> } };
    };
    const st = useStore.getState();
    return st.project.tracks.flatMap((t) =>
      t.clips.map((c) => ({
        id: c.id,
        name: st.assets[c.assetId]!.file.name,
        startMs: c.timelineStartMs,
        endMs: c.timelineStartMs + (c.sourceOutMs - c.sourceInMs) / c.speed,
      })),
    );
  }, store);
}

/** The loudness of the full cut's mix over one span, as the export renders it. */
async function playedLufs(page: Page, startMs: number, endMs: number): Promise<number> {
  const store = await appModuleUrl(page, '/src/store/store.ts');
  const exporter = await appModuleUrl(page, '/src/export/exporter.ts');
  return page.evaluate(
    async ({ s, e, from, to }) => {
      const { useStore } = (await import(s)) as { useStore: { getState: () => { project: unknown; assets: unknown } } };
      const { measureMixLoudness } = (await import(e)) as {
        measureMixLoudness: (p: unknown, a: unknown, from: number, dur: number) => Promise<{ lufs: number } | null>;
      };
      const st = useStore.getState();
      return (await measureMixLoudness(st.project, st.assets, from, to - from))!.lufs;
    },
    { s: store, e: exporter, from: startMs, to: endMs },
  );
}

test('every clip plays at the common level after a balance: mono, downmixed, compressed', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', [
    { name: 'stereo.wav', mimeType: 'audio/wav', buffer: wav(4, [0.08, 0.08]) },
    { name: 'mono.wav', mimeType: 'audio/wav', buffer: wav(4, [0.1]) },
    { name: 'left-only.wav', mimeType: 'audio/wav', buffer: wav(4, [0.25, 0]) },
    { name: 'compressed.wav', mimeType: 'audio/wav', buffer: wav(4, [0.06, 0.06]) },
  ]);
  await expect(page.locator('[data-clip-id]')).toHaveCount(4);

  const store = await appModuleUrl(page, '/src/store/store.ts');
  await page.evaluate(async (s) => {
    const { useStore } = (await import(s)) as {
      useStore: { getState: () => { project: { tracks: { clips: { id: string; assetId: string }[] }[] }; assets: Record<string, { file: File }>; updateClipCommitted: (id: string, patch: unknown) => void } };
    };
    const st = useStore.getState();
    for (const t of st.project.tracks) {
      for (const c of t.clips) {
        const name = st.assets[c.assetId]!.file.name;
        if (name === 'left-only.wav') st.updateClipCommitted(c.id, { mono: true });
        if (name === 'compressed.wav') st.updateClipCommitted(c.id, { audioFx: [{ type: 'leveler', amount: 0.8 }] });
      }
    }
  }, store);

  // The way a user does it: select everything, Clip > Match volumes.
  await page.locator('[data-clip-id]').first().click();
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Match volumes' }).click();
  // Every level here is within the fader's range: a "could not reach" would
  // be the balance missing, not the fixture asking too much.
  await expect(page.getByText('Volume balanced across 4 clips', { exact: true })).toBeVisible({ timeout: 60_000 });

  for (const clip of await clips(page)) {
    const lufs = await playedLufs(page, clip.startMs, clip.endMs);
    expect(Math.abs(lufs - -16), `${clip.name} plays at ${lufs.toFixed(2)} LUFS`).toBeLessThan(0.35);
  }
});
