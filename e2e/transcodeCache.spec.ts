import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

/**
 * The on-disk cache of a transcoded audio track, end to end.
 *
 * Transcoding an undecodable track takes minutes, and before this cache existed
 * every reopen paid it again. What is being checked is the whole loop, not any
 * one function: the compressed copy written after a transcode, the IndexedDB
 * store surviving a reload, and the restore republishing the track so the rest
 * of the app finds it audible without knowing a transcode ever happened.
 *
 * The cache payload is produced by the real converter rather than faked, since
 * "the bytes decode back" is precisely the property at issue - a codec whose
 * container cannot carry its encoder delay round-trips with 21 ms of silence
 * bolted on, and that is the failure this has to be able to see.
 */
test('a transcoded track survives a reload without re-transcoding', async ({ page }) => {
  test.setTimeout(180_000);

  // A real project has to exist for the restore to run at all: hydration is
  // skipped outright when no valid project was ever saved.
  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  const assetId = 'cached-audio-asset';

  // Encode the cache payload the same way a transcode would, then register an
  // asset whose track claims to be undecodable - which is what makes the
  // restore consider it.
  // Resolved against the modules the page has actually loaded: a bare
  // '/src/…' specifier can pull a SECOND copy of the module (see appModule.ts),
  // and the store it seeds would then be one the app never reads.
  const mods = {
    transcode: await appModuleUrl(page, '/src/media/transcodeAudio.ts'),
    // The cache lives in its own module; persistence.ts only consumes it.
    audioCache: await appModuleUrl(page, '/src/lib/audioCache.ts'),
    store: await appModuleUrl(page, '/src/store/store.ts'),
    mediaCache: await appModuleUrl(page, '/src/media/mediaCache.ts'),
  };

  const seeded = await page.evaluate(async ({ id, m }) => {
    const SR = 48000;
    const n = SR; // one second
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ascii = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    ascii(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ascii(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ascii(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / SR) * 20000), true);
    }
    const file = new File([buf], 'tone.wav', { type: 'audio/wav' });

    const { transcodeAudioTrack } = await import(m.transcode);
    const { saveTranscodedAudio } = await import(m.audioCache);
    const { useStore } = await import(m.store);

    const { compressed } = await transcodeAudioTrack(
      { id, file, kind: 'audio', durationMs: 1000, hasAudio: true, audioTracks: [], thumbnails: [] },
      0,
    );
    if (!compressed) return { cachedBytes: 0 };

    useStore.getState().addAsset({
      id,
      file,
      kind: 'audio',
      durationMs: 1000,
      hasAudio: false,
      audioTracks: [{ index: 0, channels: 2, undecodable: true, codec: 'eac3' }],
      thumbnails: [],
    });
    await saveTranscodedAudio(file, 0, compressed);
    return { cachedBytes: compressed.byteLength };
  }, { id: assetId, m: mods });

  expect(seeded.cachedBytes).toBeGreaterThan(0);

  // Come back as a fresh session - once the asset is really on disk. `addAsset`
  // above schedules a debounced write, so the reload has to wait for the record
  // rather than for a length of time: the database is the thing the next
  // session reads, so it is the thing worth asking.
  await expect
    .poll(
      async () =>
        page.evaluate(async ({ persistence, store }) => {
          const persist = (await import(persistence)) as {
            flushProjectSave: () => void;
            loadProjectById: (id: string) => Promise<{ assets: unknown[] } | null>;
          };
          const { useStore } = (await import(store)) as { useStore: { getState: () => never } };
          persist.flushProjectSave();
          const id = (useStore.getState() as unknown as { project: { id: string } }).project.id;
          return (await persist.loadProjectById(id))?.assets.length ?? 0;
        }, {
          persistence: await appModuleUrl(page, '/src/lib/persistence.ts'),
          store: await appModuleUrl(page, '/src/store/store.ts'),
        }),
      { message: 'the audio asset was written to IndexedDB' },
    )
    .toBeGreaterThan(0);
  await page.reload();

  // The restore decodes in the background, so the flag arrives asynchronously -
  // exactly as the user sees the track light up a moment after the project opens.
  // Re-resolved after the reload: the page's module graph is a fresh one.
  const afterReload = {
    store: await appModuleUrl(page, '/src/store/store.ts'),
    mediaCache: await appModuleUrl(page, '/src/media/mediaCache.ts'),
  };

  const restored = await page.evaluate(async ({ id, m }) => {
    const { useStore } = await import(m.store);
    const { getAudioBuffer } = await import(m.mediaCache);

    const deadline = Date.now() + 30_000;
    for (;;) {
      const asset = useStore.getState().assets[id];
      const track = asset?.audioTracks?.[0];
      if (track?.transcoded) {
        const buffer = await getAudioBuffer(asset, 0);
        return {
          transcoded: true,
          hasAudio: asset.hasAudio,
          peaks: track.peaks?.length ?? 0,
          duration: buffer ? buffer.duration : 0,
          // Silence would satisfy every structural check above.
          peak: buffer ? Math.max(...buffer.getChannelData(0).map(Math.abs)) : 0,
        };
      }
      if (Date.now() > deadline) {
        return { transcoded: false, hasAudio: asset?.hasAudio ?? null, peaks: 0, duration: 0, peak: 0 };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, { id: assetId, m: afterReload });

  // The track is audible again, and nothing re-ran the converter to get there.
  expect(restored.transcoded).toBe(true);
  expect(restored.hasAudio).toBe(true);
  expect(restored.peaks).toBeGreaterThan(0);
  // Sample-accurate round-trip: a container that loses the encoder delay would
  // come back long, and the audio would sit late against picture on every open.
  expect(restored.duration).toBeGreaterThan(0.98);
  expect(restored.duration).toBeLessThan(1.02);
  expect(restored.peak).toBeGreaterThan(0.3);
});
