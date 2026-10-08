/**
 * 24-bit PCM WAV, written a slice at a time.
 *
 * 24-bit because it is what every editing application imports without
 * conversion and what a mix stem is expected to be: 16 bits would throw away
 * the headroom the editor is about to mix into, and 32-bit float is still
 * refused by a few tools. The samples arrive as the mixer renders them and
 * leave as Blob parts, so a long stem never exists as one array.
 */
export class WavWriter {
  /**
   * One Blob per slice rather than the bytes themselves: a Blob can leave the
   * JS heap (the browser backs large ones on disk), so an hour-long stem is not
   * a gigabyte of live arrays waiting for `finish`.
   */
  private readonly parts: Blob[] = [];
  private frames = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {}

  /** Append planar float samples (one array per channel, equal lengths). */
  push(planar: readonly Float32Array[]): void {
    const length = planar[0]?.length ?? 0;
    const out = new Uint8Array(length * this.channels * 3);
    let o = 0;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < this.channels; ch++) {
        const s = Math.max(-1, Math.min(1, planar[ch]?.[i] ?? 0));
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        out[o++] = v & 0xff;
        out[o++] = (v >> 8) & 0xff;
        out[o++] = (v >> 16) & 0xff;
      }
    }
    this.parts.push(new Blob([out]));
    this.frames += length;
  }

  /** Whether anything above silence was written (-90 dBFS). */
  static isSilent(planar: readonly Float32Array[]): boolean {
    for (const ch of planar) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]!) > 3e-5) return false;
    return true;
  }

  finish(): Blob {
    const dataBytes = this.frames * this.channels * 3;
    const header = new Uint8Array(44);
    const v = new DataView(header.buffer);
    const ascii = (at: number, s: string) => {
      for (let i = 0; i < s.length; i++) header[at + i] = s.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, this.channels, true);
    v.setUint32(24, this.sampleRate, true);
    v.setUint32(28, this.sampleRate * this.channels * 3, true);
    v.setUint16(32, this.channels * 3, true);
    v.setUint16(34, 24, true);
    ascii(36, 'data');
    v.setUint32(40, dataBytes, true);
    return new Blob([header, ...this.parts], { type: 'audio/wav' });
  }
}
