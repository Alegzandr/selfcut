import { test, expect } from './test';

/**
 * End-to-end check of the on-demand audio conversion pipeline.
 *
 * Everything here happens inside a real browser because none of it can happen
 * anywhere else: the whole point of the module is a wasm build of ffmpeg running
 * in a module worker, mounting a File through WORKERFS. A unit test can only
 * assert the store logic around it, which is exactly the part that was never
 * broken - the load path was, silently, because the ESM/UMD mismatch only shows
 * up when the worker actually tries to import the core.
 *
 * The fixture is a synthesized WAV rather than an E-AC-3 rip: what needs proving
 * is the plumbing (worker boots, mount, exec, readFile, decodeAudioData), and a
 * 32 MB codec-specific sample in the repo would prove nothing extra. The E-AC-3,
 * AC-3 and DTS decoders are compiled into the core either way.
 */

test('converts an audio track through ffmpeg.wasm and reports each phase', async ({ page }) => {
  await page.goto('/app/');

  const result = await page.evaluate(async () => {
    /** A one-second 440 Hz mono tone as a WAV File. */
    const makeWav = (seconds: number, sampleRate: number): File => {
      const n = seconds * sampleRate;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const w = (o: number, s: string) => {
        for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
      };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
      w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) {
        const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 20000;
        v.setInt16(44 + i * 2, Math.round(sample), true);
      }
      return new File([buf], 'tone.wav', { type: 'audio/wav' });
    };

    const file = makeWav(1, 48000);
    // A server URL Vite resolves in the page, not a path on disk: keep the
    // specifier out of a literal so tsc does not try to resolve it from here.
    const modulePath = '/src/media/transcodeAudio.ts';
    const { transcodeAudioTrack } = await import(modulePath);

    const phases: string[] = [];
    const ratios: number[] = [];
    const { buffer, compressed } = await transcodeAudioTrack(
      { id: 'a', file, kind: 'audio', durationMs: 1000, hasAudio: true, audioTracks: [], thumbnails: [] },
      0,
      {
        onProgress: (p: { phase: string; ratio: number | null }) => {
          if (phases.at(-1) !== p.phase) phases.push(p.phase);
          if (p.phase === 'downloading' && p.ratio != null) ratios.push(p.ratio);
        },
      },
    );
    return {
      phases,
      ratios,
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      // A silent result would still "work" structurally: check there is signal.
      peak: Math.max(...buffer.getChannelData(0).map(Math.abs)),
      // The compressed copy rides on the same exec and is what makes a reopened
      // project audible without re-transcoding: its absence is a silent
      // regression, since the session itself works fine without it.
      compressedBytes: compressed ? compressed.byteLength : 0,
    };
  });

  // The order matters: it is what the progress UI narrates.
  expect(result.phases).toEqual(['downloading', 'converting', 'decoding']);
  // The 32 MB core must report real byte progress, and reaching the end of it
  // must not be mistaken for a truncated download - the mistake that made every
  // conversion fail on any host that compresses the response.
  expect(result.ratios.length).toBeGreaterThan(1);
  expect(result.ratios.at(-1)).toBeCloseTo(1, 5);
  expect(result.ratios).toEqual([...result.ratios].sort((a, b) => a - b));
  expect(result.duration).toBeGreaterThan(0.9);
  expect(result.duration).toBeLessThan(1.1);
  // -ac 2 downmixes to the stereo the mix bus expects, whatever the source.
  expect(result.channels).toBe(2);
  // The tone peaks at 20000/32768 = 0.61 at the source; the mono-to-stereo
  // downmix costs the usual 3 dB (x0.707), landing near 0.43. Asserted loosely:
  // the point is that sound came through, not the exact downmix gain.
  expect(result.peak).toBeGreaterThan(0.3);
  // Opus of a one-second tone is small but never empty.
  expect(result.compressedBytes).toBeGreaterThan(0);
});
