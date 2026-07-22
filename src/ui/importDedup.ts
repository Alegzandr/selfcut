import { isMissingSource } from '../lib/missingSource';
import type { MediaAsset } from '../types';

/**
 * The library entry an imported file is already sitting in, if any.
 *
 * Re-importing a file the project still holds has to land back on the SAME
 * asset id, so the library does not grow a second card for one file and the
 * IN-MEMORY caches - decoders, peaks, transcoded PCM, all keyed by asset id -
 * carry over instead of being rebuilt.
 *
 * The on-disk caches no longer depend on this: they key by the file itself
 * (lib/mediaKey.ts), which is what makes a removal followed by a re-import - a
 * case this function cannot see, since the asset is gone from the library it
 * searches - keep its transcoded audio and extracted cues.
 *
 * Files carry no stable identity here (no handle, no path), so the fingerprint
 * is the same triple the `.selfcut` relink banner matches on, and the same one
 * mediaKeyOf uses. `size` is left out for a detached asset: its stand-in File
 * is zero bytes, and the name and mtime are all that survived the round-trip.
 *
 * Kept apart from useImport so it stays free of the media pipeline's imports.
 */
export function findExistingAsset(
  assets: Record<string, MediaAsset>,
  file: File,
): MediaAsset | undefined {
  return Object.values(assets).find(
    (asset) => matchesFile(asset, file) || matchesRemuxSource(asset, file),
  );
}

/** The picked file is the one this asset already holds. */
function matchesFile(asset: MediaAsset, file: File): boolean {
  return (
    asset.file.name === file.name &&
    asset.file.lastModified === file.lastModified &&
    (isDetached(asset) || asset.file.size === file.size)
  );
}

/**
 * The picked file is the ORIGINAL an unreadable-container asset was remuxed
 * from. That asset's own `file` is the Matroska we wrote - a different name is
 * possible and the size always differs - so `matchesFile` never catches it, and
 * a re-import would otherwise remux the same source into a second card. The
 * remux stored the source's identity precisely so this can recognize it.
 */
function matchesRemuxSource(asset: MediaAsset, file: File): boolean {
  const src = asset.originalSource;
  return (
    src != null &&
    src.name === file.name &&
    src.size === file.size &&
    src.lastModified === file.lastModified
  );
}

/** True while an asset has no readable bytes behind it. */
export function isDetached(asset: MediaAsset): boolean {
  return asset.disconnected === true || isMissingSource(asset.file);
}
