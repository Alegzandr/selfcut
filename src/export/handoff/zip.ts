/**
 * A minimal ZIP writer: stored entries (no compression), built as Blob parts.
 *
 * Stored on purpose. Everything that goes into a hand-off folder is already
 * compressed (video, the rushes) or barely compressible (PCM audio), so
 * deflate would cost seconds of CPU for a few percent, and a stored entry can
 * keep a `File` as a Blob part instead of copying it into memory. Only the CRC
 * has to read the bytes, and it reads them as a stream.
 *
 * No ZIP64: an archive past 4 GiB is refused up front with `ZipTooLargeError`
 * rather than written with sizes that wrap around.
 */

export interface ZipEntry {
  /** Path inside the archive, forward slashes. */
  name: string;
  data: Blob;
}

const MAX_ZIP_BYTES = 0xffff_ffff;

export class ZipTooLargeError extends Error {
  constructor() {
    super('zip-too-large');
    this.name = 'ZipTooLargeError';
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the ZIP polynomial), continued from `crc` over `bytes`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

async function crcOfBlob(
  blob: Blob,
  isCanceled: () => boolean,
  onBytes: (n: number) => void,
): Promise<number> {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    if (isCanceled()) {
      await reader.cancel();
      throw new DOMException('canceled', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
    onBytes(value.length);
  }
}

/** DOS date and time fields for `date`, as ZIP stores them. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build the archive. Entry names are UTF-8 (flag bit 11), so a rush called
 * "plan séquence.mov" keeps its accents in every unzipper since 2007.
 */
export async function buildZip(
  entries: readonly ZipEntry[],
  isCanceled: () => boolean = () => false,
  onProgress?: (value: number) => void,
  now = new Date(),
): Promise<Blob> {
  const total = entries.reduce((n, e) => n + e.data.size + 128 + e.name.length * 3, 22);
  if (total > MAX_ZIP_BYTES) throw new ZipTooLargeError();

  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const bytes = entries.reduce((n, e) => n + e.data.size, 0) || 1;
  let read = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = await crcOfBlob(entry.data, isCanceled, (n) => {
      read += n;
      onProgress?.(read / bytes);
    });
    const size = entry.data.size;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, entry.data);

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    offset += local.length + size;
  }

  const centralSize = central.reduce((n, r) => n + r.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
