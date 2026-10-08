import type { LoopRegion, MediaAsset, Project } from '../types';
import { forEachProjectClip, projectDurationMs } from '../model';

/**
 * What every way out of the editor agrees on before it starts: which stretch
 * of the timeline it covers, and which sources it can no longer read. One
 * definition for the export, the editor's folder and the pre-export review,
 * so the review never calls a cut ready that the export then refuses.
 */

/** The exported span: the loop region clamped to the cut, or the whole cut. */
export function exportSpan(project: Project, region: LoopRegion | null | undefined): { startMs: number; durationMs: number } {
  const projectMs = projectDurationMs(project);
  const startMs = region ? Math.max(0, Math.min(region.startMs, projectMs)) : 0;
  const durationMs = (region ? Math.min(region.endMs, projectMs) : projectMs) - startMs;
  return { startMs, durationMs };
}

/**
 * Names of the sources the project uses and can no longer read. A render that
 * reaches one crashes mid-way or drops its audio, so every export refuses
 * them up front.
 */
export function disconnectedSourceNames(project: Project, assets: Record<string, MediaAsset>): string[] {
  const names = new Set<string>();
  forEachProjectClip(project, (clip) => {
    const asset = assets[clip.assetId];
    if (asset?.disconnected) names.add(asset.file.name);
  });
  return [...names];
}
