import type { AspectRatio } from '../types';
import type { SubtitleVAlign } from '../lib/subtitles';

/**
 * Where each vertical band puts a caption's centre, as a fraction of the output
 * height. Top and bottom keep a margin off the frame edge - a caption flush
 * against it reads as clipped, and players traditionally leave that room.
 *
 * How much room depends on the frame. Landscape follows the broadcast habit of
 * a tight lower third, near the bottom safe area; vertical and square sit
 * noticeably higher, because a phone player paints its own controls, caption
 * button and account handle over the last stretch of the frame and a subtitle
 * placed by broadcast rules ends up underneath them.
 *
 * The vertical bottom is held above the feed's caption block, which the
 * monitor's "platform interface" guide draws from y = 0.68 (`socialChrome`):
 * at 0.82 every generated caption sat under the account name and the post's
 * own description, the one place a vertical video's text cannot be read.
 */
export const CAPTION_Y: Record<AspectRatio, Record<SubtitleVAlign, number>> = {
  '16:9': { top: 0.1, middle: 0.5, bottom: 0.88 },
  '9:16': { top: 0.14, middle: 0.5, bottom: 0.62 },
  '1:1': { top: 0.12, middle: 0.5, bottom: 0.85 },
  '4:5': { top: 0.13, middle: 0.5, bottom: 0.83 },
};

/**
 * Wrap width of a generated caption, as a fraction of the output width, where
 * the frame needs one narrower than a title's default.
 *
 * A vertical feed paints its like/comment/share column down the right edge
 * (from x = 0.84 between y = 0.44 and 0.86, see `socialChrome`), right across
 * the band a caption sits in. A centred box of 0.64 ends at 0.82, so a long
 * line wraps before it reaches the buttons instead of running under them.
 */
export const CAPTION_WIDTH: Partial<Record<AspectRatio, number>> = {
  '9:16': 0.64,
};

/**
 * The band a caption's vertical centre reads as on this frame: the nearest of
 * the three placements above. Nearest rather than fixed thirds, because the
 * placements are not thirds - a vertical bottom caption sits at 0.62, which a
 * thirds rule would read back as "middle" and move on the next import.
 */
export function captionBandOf(y: number, aspect: AspectRatio): SubtitleVAlign {
  const bands = CAPTION_Y[aspect] ?? CAPTION_Y['16:9'];
  let best: SubtitleVAlign = 'bottom';
  for (const band of ['top', 'middle', 'bottom'] as const) {
    if (Math.abs(bands[band] - y) < Math.abs(bands[best] - y)) best = band;
  }
  return best;
}
