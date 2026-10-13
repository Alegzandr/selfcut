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
 * How long a scratch file is left alone after it was last written.
 *
 * The finished file is what the download reads from, and nothing tells the page
 * when a download is over - a multi-gigabyte transfer is still in flight long
 * after `click()` returns, possibly in another tab. A file untouched for this
 * long is not being rendered (a render writes continuously) and is past any
 * download a person would still be waiting on.
 */
export const SCRATCH_GRACE_MS = 10 * 60_000;

/** Web Lock held, shared, for as long as a render writes into a scratch file. */
const SCRATCH_LOCK_PREFIX = 'selfcut-export-scratch:';

export interface ScratchEntry {
  name: string;
  /** `File.lastModified`; 0 when it could not be read. */
  lastModified: number;
}

export interface ScratchSweepOptions {
  /** Names never removed: the export that is about to use, or just produced, them. */
  keep?: readonly string[];
  /**
   * Also spare the most recently written of the others. Set when a NEW export
   * starts: the previous one's file may still be downloading, and it is only
   * reclaimed once the new export has finished (see `startExport`).
   */
  keepNewest?: boolean;
}

/**
 * Which scratch files a sweep may remove. Pure, so the rules can be tested
 * without a file system: a file is spared if it is kept by name, locked by a
 * render in progress (in any tab), written within `SCRATCH_GRACE_MS`, or - with
 * `keepNewest` - the most recent of the others.
 */
export function scratchToSweep(
  entries: readonly ScratchEntry[],
  now: number,
  locked: ReadonlySet<string>,
  options: ScratchSweepOptions = {},
): string[] {
  const keep = new Set(options.keep ?? []);
  const candidates = entries.filter((e) => !keep.has(e.name) && !locked.has(e.name));
  let newest: ScratchEntry | null = null;
  if (options.keepNewest) {
    for (const e of candidates) if (!newest || e.lastModified > newest.lastModified) newest = e;
  }
  return candidates
    .filter((e) => e !== newest && now - e.lastModified >= SCRATCH_GRACE_MS)
    .map((e) => e.name);
}

/** Names of the scratch files a render holds the lock on, in any tab. */
async function lockedScratch(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const state = await navigator.locks?.query();
    for (const lock of state?.held ?? []) {
      if (lock.name?.startsWith(SCRATCH_LOCK_PREFIX)) {
        out.add(lock.name.slice(SCRATCH_LOCK_PREFIX.length));
      }
    }
  } catch {
    /* no Web Locks: the age rule alone protects files in use */
  }
  return out;
}

/**
 * Mark a scratch file as in use until the returned release is called. Without
 * Web Locks the release does nothing, and the age rule protects the file.
 */
async function lockScratch(name: string): Promise<() => void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // Shared: two renders of one file name (two tabs) must not wait on each
    // other - the lock only has to be visible to `query()`.
    await new Promise<void>((granted, refused) => {
      locks
        .request(SCRATCH_LOCK_PREFIX + name, { mode: 'shared' }, () => {
          granted();
          return held;
        })
        .catch(refused);
    });
  } catch {
    return () => {};
  }
  return release;
}

/**
 * Delete leftover scratch files that nothing is using any more.
 *
 * A finished export's file is deliberately NOT deleted the moment the download
 * starts: the download reads from that very file, and a multi-gigabyte transfer
 * is still in flight long after `click()` returns. So the sweep is what
 * reclaims it - once the next export has finished, and at startup - and only
 * when it is neither locked by a render nor recently written (see
 * `scratchToSweep`): another tab may be rendering into, or downloading from, a
 * file this one knows nothing about.
 */
export async function sweepExportScratch(options: ScratchSweepOptions = {}): Promise<void> {
  const dir = await scratchDir();
  if (!dir) return;
  try {
    const entries: ScratchEntry[] = [];
    // `keys()` is async-iterable on the directory handle; a browser without it
    // simply keeps its scratch file until the origin's storage is cleared.
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const lastModified = await dir
        .getFileHandle(name)
        .then((handle) => handle.getFile())
        .then((file) => file.lastModified)
        .catch(() => 0);
      entries.push({ name, lastModified });
    }
    const locked = await lockedScratch();
    for (const name of scratchToSweep(entries, Date.now(), locked, options)) {
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
 *
 * The file is locked as in use until `release` is called, which the export does
 * once it has settled; until then no sweep, in this tab or another, removes it.
 */
export async function openExportScratch(
  filename: string,
): Promise<{ handle: FileSystemFileHandle; name: string; release: () => void } | null> {
  const dir = await scratchDir();
  if (!dir) return null;
  // Locked before the file exists, so a sweep starting in another tab can never
  // see it unlocked.
  const release = await lockScratch(filename);
  try {
    // Sweep first: old exports' files can be gigabytes, and keeping them all
    // alongside the new one would multiply what the origin holds. The most
    // recent one is spared - it may still be downloading - and reclaimed once
    // this export has finished.
    await sweepExportScratch({ keep: [filename], keepNewest: true });
    const handle = await dir.getFileHandle(filename, { create: true });
    return { handle, name: filename, release };
  } catch {
    release();
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
