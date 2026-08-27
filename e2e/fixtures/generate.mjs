/**
 * One-shot fixture generator for the e2e suite. Run manually when a fixture
 * needs to change:
 *
 *   node e2e/fixtures/generate.mjs
 *
 * The generated files are checked in, so CI never runs this.
 *
 * - clip.mp4: 3 s of 320x180 H.264, 30 fps, no audio. Encoded in headless
 *   Chromium (Node has no WebCodecs) with mediabunny's browser bundle: a
 *   canvas animation feeds a CanvasSource whose output is muxed to MP4.
 *   Video-only on purpose - a video with audio imports as a *linked pair*
 *   (two clips), which would complicate every clip-count assertion.
 * - tone.wav: 2 s of 16-bit PCM mono at 22.05 kHz with an amplitude
 *   envelope, written directly from Node (RIFF header + samples).
 * - checker.png: a 256x256 black-and-white checkerboard, written directly from
 *   Node (a one-chunk PNG). A still, so it imports without a video codec, and
 *   nothing but hard edges - which is what makes it a blur meter: the average
 *   difference between neighbouring pixels is high while it is sharp and falls
 *   to near zero once something has actually blurred it.
 */
import { chromium } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

async function generateMp4() {
  const bundle = await readFile(
    path.join(root, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'),
    'utf8',
  );
  // channel 'chromium' selects the full browser in new-headless mode; the
  // default headless shell has a WebCodecs VideoEncoder that stalls forever.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    // WebCodecs requires a secure context, which about:blank (opaque origin) is
    // not. localhost qualifies, so serve an empty page there straight from the
    // route handler - no actual server involved.
    await page.route('http://localhost/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }),
    );
    await page.goto('http://localhost/');
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));
    const base64 = await page.evaluate(async (bundleCode) => {
      const url = URL.createObjectURL(new Blob([bundleCode], { type: 'text/javascript' }));
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource } = await import(url);

      const width = 320;
      const height = 180;
      const fps = 30;
      const seconds = 3;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 400_000 });
      output.addVideoTrack(source, { frameRate: fps });
      await output.start();

      const total = fps * seconds;
      for (let i = 0; i < total; i++) {
        const t = i / total;
        // A hue sweep plus a moving box and a frame counter: every frame is
        // distinct, so a split/seek bug shows up as the wrong picture.
        ctx.fillStyle = `hsl(${Math.round(t * 360)} 60% 35%)`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#fff';
        ctx.fillRect((width - 40) * t, height / 2 - 20, 40, 40);
        ctx.font = 'bold 28px monospace';
        ctx.fillText(String(i), 12, 34);
        await source.add(i / fps, 1 / fps);
      }
      source.close();
      await output.finalize();

      const bytes = new Uint8Array(output.target.buffer);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    }, bundle);
    const buffer = Buffer.from(base64, 'base64');
    await writeFile(path.join(here, 'clip.mp4'), buffer);
    console.log(`clip.mp4: ${buffer.length} bytes`);
  } finally {
    await browser.close();
  }
}

async function generateWav() {
  const sampleRate = 22050;
  const seconds = 2;
  const count = sampleRate * seconds;
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    // 440 Hz tone with a slow tremolo so the waveform has a visible envelope.
    const envelope = 0.4 + 0.35 * Math.sin(2 * Math.PI * 1.5 * t);
    const sample = Math.sin(2 * Math.PI * 440 * t) * envelope;
    data.writeInt16LE(Math.round(sample * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const wav = Buffer.concat([header, data]);
  await writeFile(path.join(here, 'tone.wav'), wav);
  console.log(`tone.wav: ${wav.length} bytes`);
}

/** A PNG chunk: length, type, payload, CRC. */
function pngChunk(type, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

async function generateCheckerPng() {
  const size = 256;
  const cell = 8;
  // One filter byte (0 = none) then RGB triplets, per scanline.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0;
    for (let x = 0; x < size; x++) {
      const v = (((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0 ? 255 : 0;
      raw[at++] = v;
      raw[at++] = v;
      raw[at++] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(path.join(here, 'checker.png'), png);
  console.log(`checker.png: ${png.length} bytes`);
}

await generateMp4();
await generateWav();
await generateCheckerPng();
