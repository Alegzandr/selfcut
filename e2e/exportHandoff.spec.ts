import { test, expect } from './test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "For my editor", from the export sheet to the bytes of the folder.
 *
 * What an editor on Premiere or DaVinci receives has to open there: the XML
 * must name the rushes the folder carries, each lane that makes sound must be
 * a WAV that is not silence, and the sound must leave raw - the platform
 * normalization belongs to the Publish door only.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Entries of a stored (uncompressed) ZIP, read from its central directory. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localName = bytes.readUInt16LE(local + 26);
    const localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    out.set(name, bytes.subarray(start, start + size));
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/** Peak of a 24-bit PCM WAV's samples, 0..1. */
function wavPeak(wav: Buffer): number {
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt16LE(34)).toBe(24);
  let peak = 0;
  for (let o = 44; o + 3 <= wav.length; o += 3) {
    let v = wav[o]! | (wav[o + 1]! << 8) | (wav[o + 2]! << 16);
    if (v & 0x800000) v -= 0x1000000;
    peak = Math.max(peak, Math.abs(v) / 0x800000);
  }
  return peak;
}

test('the editor folder carries the timeline, one stem per sounding lane, and the rushes', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', [path.join(FIXTURES, 'checker.png'), path.join(FIXTURES, 'tone.wav')]);
  await expect(page.locator('[data-clip-id]')).toHaveCount(2);

  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await sheet.getByRole('button', { name: /^For my editor/ }).click();

  // Raw sound behind this door: no normalization checkbox, a sentence instead.
  await expect(sheet.getByRole('checkbox', { name: /Platform-ready loudness/ })).toHaveCount(0);
  await expect(sheet.getByText(/^Raw sound/)).toBeVisible();
  await expect(sheet.getByRole('checkbox', { name: /Include the rushes/ })).toBeChecked();

  await sheet.getByRole('textbox', { name: 'File name' }).fill('episode 12');
  const download = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Prepare the folder' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('episode 12.zip');
  await expect(sheet.getByText(/Timeline and 1 audio track/)).toBeVisible();

  const entries = unzip(await readFile((await file.path())!));
  const names = [...entries.keys()].sort();
  expect(names).toEqual(['README.txt', 'audio/A1.wav', 'episode 12.xml', 'rushes/checker.png', 'rushes/tone.wav']);

  const xml = entries.get('episode 12.xml')!.toString('utf8');
  expect(xml).toContain('<xmeml version="5">');
  expect(xml).toContain('<name>checker.png</name>');
  expect(xml).toContain('<name>tone.wav</name>');
  expect(entries.get('rushes/tone.wav')!.length).toBeGreaterThan(1000);
  expect(wavPeak(entries.get('audio/A1.wav')!)).toBeGreaterThan(0.01);
});

test('the Publish door keeps the platform loudness, and the editor door does not touch it', async ({ page }) => {
  await page.goto('/app/');
  await page.setInputFiles('input[type=file]', path.join(FIXTURES, 'tone.wav'));
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  const loudness = sheet.getByRole('checkbox', { name: /Platform-ready loudness/ });
  await expect(loudness).toBeChecked();

  await sheet.getByRole('button', { name: /^For my editor/ }).click();
  await sheet.getByRole('button', { name: /^Publish/ }).click();
  // Visiting the editor door must not have switched the remembered habit off.
  await expect(loudness).toBeChecked();
});
