/**
 * The download fallback for browsers without the File System Access API
 * (Firefox, Safari). Shared by every "write a document to disk" path - the
 * project file and the effects presets - so the two cannot drift apart in how
 * they behave off Chromium.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Not right away: the click only schedules the download, and Firefox and
  // Safari read the blob URL after this returns - revoked synchronously, the
  // file can come out empty or fail outright. A minute is far longer than any
  // browser takes to pick it up, and holding the blob that long costs nothing.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
