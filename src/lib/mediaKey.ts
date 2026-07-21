import { isMissingSource } from './missingSource';

/**
 * The identity a cached artifact is filed under: the file, not the asset.
 *
 * Everything derived from a source file by ffmpeg - transcoded audio, extracted
 * subtitle cues - costs minutes to produce and is reproducible from the file
 * alone. So the cache should hit whenever the same bytes come back, whatever the
 * app happens to be calling them this session.
 *
 * The asset id cannot express that. It is `crypto.randomUUID()`, minted per
 * import and unrelated to the file: remove an asset and import the same file
 * again and the cache misses, while the still-valid bytes sit on disk
 * unreachable until the next startup sweep collects them. Import dedup covers
 * only the case where the asset is still IN the library, which is precisely the
 * case where nothing was lost.
 *
 * Files carry no stable identity in the browser (no handle, no path, no inode),
 * so the fingerprint is the same triple the relink banner and import dedup
 * already match on. It can collide in theory - two different files of identical
 * name, size and mtime - and that is accepted: the cost is one wrong audio
 * track, the same failure mode a relink already has, and the same triple is
 * what the OS itself hands out.
 *
 * The name goes through encodeURIComponent so no separator can appear inside a
 * component: keys are `${mediaKey}#${trackIndex}`, and a file named `a#b.mkv`
 * would otherwise be indistinguishable from a track index.
 */
export function mediaKeyOf(file: File): string | null {
  // A placeholder is not a file. It is a zero-byte stand-in for an asset
  // waiting to be relinked, so every unrelinked asset of a given name would key
  // to the same entry - and to one that belongs to none of them.
  if (isMissingSource(file)) return null;
  return `${file.size}-${file.lastModified}-${encodeURIComponent(file.name)}`;
}
