import type { AspectRatio } from '../types';

/**
 * The monitor's guide overlays. Monitoring only, like the surround colour:
 * nothing here is ever composited into a frame.
 *
 * - `safe`: the broadcast action-safe (90%) and title-safe (80%) margins, plus
 *   a centre cross. What a title is kept inside so a TV overscan or a phone's
 *   rounded corners never eat it.
 * - `thirds`: the rule-of-thirds grid, for framing a reframe or a punch-in.
 * - `social`: the chrome the destination app paints over the picture - the
 *   caption block and the button column of a vertical feed, the control bar of
 *   a landscape player. Drawn from the aspect ratio, since the ratio is what
 *   says where the cut is going.
 */
export type PreviewGuides = 'off' | 'safe' | 'thirds' | 'social';

export const PREVIEW_GUIDE_MODES: readonly PreviewGuides[] = ['off', 'safe', 'thirds', 'social'];

/** A rectangle in normalized frame coordinates (0..1 on both axes). */
export interface GuideRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The regions a platform's own interface covers, per aspect ratio, in
 * normalized frame coordinates. Measured off the current TikTok / Reels /
 * Shorts players for 9:16 (username, caption and sound line at the bottom,
 * the like/comment/share column on the right, the status bar and tabs at the
 * top), the YouTube player chrome for 16:9, and the feed post chrome for the
 * square and 4:5 crops. Approximate on purpose: the apps move these by a few
 * percent every year, and what matters is keeping a face and a title clear of
 * them, not matching a pixel.
 */
export function socialChrome(aspect: AspectRatio): GuideRect[] {
  switch (aspect) {
    case '9:16':
      return [
        { x: 0, y: 0, w: 1, h: 0.11 },
        { x: 0, y: 0.68, w: 0.82, h: 0.32 },
        { x: 0.84, y: 0.44, w: 0.16, h: 0.42 },
      ];
    case '16:9':
      return [
        { x: 0, y: 0.88, w: 1, h: 0.12 },
        { x: 0, y: 0, w: 1, h: 0.09 },
      ];
    case '1:1':
    case '4:5':
      return [{ x: 0, y: 0.86, w: 1, h: 0.14 }];
  }
}
