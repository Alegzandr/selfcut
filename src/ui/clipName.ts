import type { TFunction } from 'i18next';
import type { Clip, MediaAsset } from '../types';

/**
 * Name of a clip as the user knows it: a generated clip is named after what it
 * renders, a media clip after its file.
 *
 * It lives here rather than in the inspector because the inspector heading is no
 * longer its only reader - saving a preset names the file after the clip it came
 * from, and the two must agree.
 */
export function clipDisplayName(clip: Clip, asset: MediaAsset | undefined, t: TFunction): string {
  switch (clip.kind) {
    case 'text':
      return t('inspector.textClip');
    case 'solid':
      return t(`inspector.solid.${clip.solid.kind}`);
    case 'shape':
      return t(`preview.shape.${clip.shape.kind}`);
    default:
      return asset?.file.name ?? '';
  }
}
