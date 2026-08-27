/**
 * Scratch space in the origin private file system, used as the export's sink
 * when the browser cannot hand us a real file to write into.
 *
 * Without it, an export that could not open the save picker fell back to
 * building the whole MP4 in a single growing ArrayBuffer. That works for a
 * one-minute 1080p clip and cannot work for the exports people actually reach
 * for a preset like "120 fps · 4K" with: at ~134 Mbps a six-minute render is
 * ~6 GB in one contiguous allocation, and the render died with the browser's
 * raw "Array buffer allocation failed" partway through. Writing to OPFS instead
 * keeps memory flat whatever the length, and the finished file is still handed
 * back as a downloadable Blob.
 *
 * OPFS is private to the origin and invisible in the user's file system, so
 * nothing here can touch their documents.
 */

/**
 * Where scratch files live under the origin's private root. Exported because
 * the export worker re-opens the file by name rather than being handed the
 * handle: WebKit will not put a `FileSystemFileHandle` through `postMessage`
 * (it refuses the whole message with "The object can not be cloned."), and a
 * directory name and a filename are two strings every engine copies.
 */
export const SCRATCH_DIR = 'exports';

async function scratchDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    return await root.getDirectoryHandle(SCRATCH_DIR, { create: true });
  } catch {
    // No OPFS (older Safari), or storage denied in this context.
    return null;
  }
}

/**
 * Delete leftover scratch files, keeping `except` if given.
 *
 * A finished export's file is deliberately NOT deleted the moment the download
 * starts: the download reads from that very file, and a multi-gigabyte transfer
 * is still in flight long after `click()` returns. So the sweep is what
 * reclaims it - on the next export, and once more at startup.
 */
export async function sweepExportScratch(except?: string): Promise<void> {
  const dir = await scratchDir();
  if (!dir) return;
  try {
    // `keys()` is async-iterable on the directory handle; a browser without it
    // simply keeps its scratch file until the origin's storage is cleared.
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name === except) continue;
      await dir.removeEntry(name).catch(() => undefined);
    }
  } catch {
    /* best effort - a leftover costs disk, never correctness */
  }
}

/**
 * A writable scratch file for one export, or null when OPFS is unavailable.
 * The handle is structured-cloneable, so the export worker streams into it
 * directly and the main thread never sees the bytes.
 */
export async function openExportScratch(
  filename: string,
): Promise<{ handle: FileSystemFileHandle; name: string } | null> {
  const dir = await scratchDir();
  if (!dir) return null;
  try {
    // Sweep first: the previous export's file can be gigabytes, and keeping it
    // alongside the new one would double what the origin holds for no reason.
    await sweepExportScratch(filename);
    const handle = await dir.getFileHandle(filename, { create: true });
    return { handle, name: filename };
  } catch {
    return null;
  }
}

/**
 * The scratch file of this name, re-opened wherever the caller is - the export
 * worker included, which is the point: it receives the name and finds the file
 * itself. Null when OPFS is not there or the file is not.
 */
export async function reopenExportScratch(name: string): Promise<FileSystemFileHandle | null> {
  const dir = await scratchDir();
  if (!dir) return null;
  try {
    return await dir.getFileHandle(name);
  } catch {
    return null;
  }
}

/** The finished scratch file, as a File ready to be downloaded. */
export async function readExportScratch(handle: FileSystemFileHandle): Promise<File> {
  return handle.getFile();
}

/**
 * Remove the scratch directory itself, not just its contents.
 *
 * Only the full data erase needs this: everywhere else the directory is worth
 * keeping, because the next export recreates it anyway. Best effort, like the
 * sweep - a directory that refuses to go holds no user data once it is empty.
 */
export async function removeExportScratch(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(SCRATCH_DIR, { recursive: true });
  } catch {
    /* no OPFS, or nothing there to remove */
  }
}
