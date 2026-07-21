import { isMissingSource } from '../lib/missingSource';
import type { MediaAsset } from '../types';

/**
 * The library entry an imported file is already sitting in, if any.
 *
 * Re-importing a file the project still holds has to land back on the SAME
 * asset id: the transcoded audio cache is keyed by asset id, both in memory
 * and in IndexedDB, so a fresh random id would silently discard a conversion
 * that costs the user several minutes to redo.
 *
 * Files carry no stable identity here (no handle, no path), so the fingerprint
 * is the same triple the `.selfcut` relink banner matches on. `size` is left
 * out for a detached asset: its stand-in File is zero bytes, and the name and
 * mtime are all that survived the round-trip.
 *
 * Kept apart from useImport so it stays free of the media pipeline's imports.
 */
export function findExistingAsset(
  assets: Record<string, MediaAsset>,
  file: File,
): MediaAsset | undefined {
  return Object.values(assets).find(
    (asset) =>
      asset.file.name === file.name &&
      asset.file.lastModified === file.lastModified &&
      (isDetached(asset) || asset.file.size === file.size),
  );
}

/** True while an asset has no readable bytes behind it. */
export function isDetached(asset: MediaAsset): boolean {
  return asset.disconnected === true || isMissingSource(asset.file);
}
