import type { MediaAsset, Project, Track } from '../../types';

/** Pure naming and mixing helpers of the editor's folder (see `handoff.ts`). */

/** Characters no file system accepts in a name, and path separators. */
export const cleanName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '').trim();

/**
 * The name each used asset carries in the folder, unique: two rushes both
 * called IMG_0001.MOV from two cards must not overwrite one another.
 *
 * A remuxed source is shipped as the file SelfCut actually holds when the
 * rushes travel, and referred to by its original name when they do not - the
 * editor relinks to the copy they already have.
 */
export function rushNames(
  assets: readonly MediaAsset[],
  includeRushes: boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const asset of assets) {
    const raw = cleanName((includeRushes ? undefined : asset.originalSource?.name) ?? asset.file.name) || asset.id;
    const dot = raw.lastIndexOf('.');
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    const ext = dot > 0 ? raw.slice(dot) : '';
    let name = raw;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    taken.add(name.toLowerCase());
    out.set(asset.id, name);
  }
  return out;
}

/** A copy of the project in which only `target` among the root lanes is heard. */
export function stemProject(project: Project, target: Track): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === target.id ? { ...track, muted: false, solo: false } : { ...track, muted: true, solo: false },
    ),
  };
}
