import type { TFunction } from 'i18next';
import type { Clip, MediaAsset, Project } from '../types';
import { findComp } from '../model';

/**
 * Name of a clip as the user knows it: a generated clip is named after what it
 * renders, a media clip after its file.
 *
 * It lives here rather than in the inspector because the inspector heading is no
 * longer its only reader - saving a preset names the file after the clip it came
 * from, and the two must agree.
 */
export function clipDisplayName(
  clip: Clip,
  asset: MediaAsset | undefined,
  t: TFunction,
  /** The project, so a comp clip can be named after the composition it plays. */
  project?: Project,
): string {
  switch (clip.kind) {
    case 'text':
      return t('inspector.textClip');
    case 'solid':
      return t(`inspector.solid.${clip.solid.kind}`);
    case 'shape':
      return t(`preview.shape.${clip.shape.kind}`);
    case 'comp':
      // The composition's own name, looked up live: a comp clip has no asset to
      // borrow a filename from, and the name is the only thing that tells two
      // precomps apart.
      return (
        (project && findComp(project, clip.compId)?.name) || t('comp.defaultName')
      );
    default:
      return asset?.file.name ?? '';
  }
}
