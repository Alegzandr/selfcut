/**
 * Stand-in File for an asset whose bytes we do not have - the state every asset
 * of a project loaded from a `.selfcut` file starts in, since that format
 * stores metadata only and leaves the media on disk.
 *
 * It has to be recognizable rather than merely empty: the placeholder is a
 * valid zero-byte Blob and therefore *reads* fine, so the readability probe
 * used to detect moved files would clear its `disconnected` flag and leave an
 * asset that looks healthy and decodes to nothing. A dedicated MIME type no
 * real pick can produce makes the check unambiguous.
 *
 * Lives on its own so both the project-file writer and the IndexedDB restore
 * can use it without importing each other.
 */
const MISSING_SOURCE_TYPE = 'application/vnd.selfcut.missing-source';

/** True for the stand-in File of an asset waiting to be relinked. */
export function isMissingSource(file: File): boolean {
  return file.type === MISSING_SOURCE_TYPE;
}

export function missingSourceFile(name: string, lastModified: number): File {
  return new File([], name, { type: MISSING_SOURCE_TYPE, lastModified });
}
