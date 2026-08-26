/**
 * A PCM WAV built in memory, for the cases a checked-in fixture cannot cover.
 *
 * Audio is decoded in 30 s segments (see `src/media/audioSegments.ts`), so the
 * behaviour worth testing - segment boundaries inside a clip, a source far
 * longer than what is ever held at once - starts at sources minutes long. Those
 * make poor repository fixtures and perfectly good buffers: Playwright can hand
 * a file input bytes it never wrote to disk.
 */

export interface WavSpec {
  seconds: number;
  /** 8 kHz keeps a twenty-minute source to a few megabytes; speech-grade. */
  sampleRate?: number;
  /** Carrier, in Hz. */
  freq?: number;
  /**
   * Amplitude modulation, in Hz. The envelope is what an export is measured
   * against, so it has to be periodic and slow enough to survive a lossy
   * encoder: one cycle per second, read in 250 ms windows.
   */
  envHz?: number;
}

/** 16-bit mono PCM WAV bytes: a modulated tone of a known, exact period. */
export function makeWav({
  seconds,
  sampleRate = 8000,
  freq = 440,
  envHz = 1,
}: WavSpec): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    // Never silent at the trough: a window with no signal at all would read as
    // the dropout the tests are looking for.
    const envelope = 0.35 + 0.3 * Math.sin(2 * Math.PI * envHz * t);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
