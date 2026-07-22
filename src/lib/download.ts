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
  URL.revokeObjectURL(url);
}
