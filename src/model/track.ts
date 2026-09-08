import type { AudioFx, Track } from '../types';
import { sampleChannel } from './animation';
import { resolveColorAt, type ResolvedColor } from './clip';

/**
 * Track-wide FX: the grade and the effect chain a whole lane carries.
 *
 * A track's grade is the clip grade's shape sampled at a fixed instant, because
 * a track has no local time of its own - see `Track.color`. Everything else the
 * colour pass understands (LUT, curves, the identity check that skips the pass
 * entirely) comes along for free, which is the whole reason the field reuses
 * `ClipColor` instead of getting a flattened type of its own.
 */

/** Constant channels are sampled at the start of time; nothing here animates. */
const TRACK_LOCAL_MS = 0;

/**
 * The lane's grade, or null when it has none and when every channel is at the
 * identity — the answer the compositor needs to skip the whole track pass.
 */
export function resolveTrackColor(track: Track): ResolvedColor | null {
  return track.color ? resolveColorAt(track.color, TRACK_LOCAL_MS) : null;
}

/**
 * The lane's blur, 0..1 of the output height. Read apart from the grade for the
 * same reason a clip's is: blur is a spatial filter the 2D canvas applies, not
 * a channel of the WebGL pass.
 */
export function resolveTrackBlur(track: Track): number {
  return Math.max(0, Math.min(1, sampleChannel(track.color?.blur ?? 0, TRACK_LOCAL_MS)));
}

/**
 * Whether the lane's picture needs the extra composite pass at all. Asked once
 * per track per frame, so it must stay cheaper than the pass it guards: the
 * common project has no track grade anywhere and pays one property read.
 */
export function trackHasPictureFx(track: Track): boolean {
  return !!track.color && (resolveTrackColor(track) !== null || resolveTrackBlur(track) > 0);
}

/** The effects the lane's bus actually runs, or null when it runs none. */
export function trackAudioFx(track: Track): AudioFx[] | null {
  const fx = track.audioFx?.filter((f) => f.amount > 0);
  return fx && fx.length > 0 ? fx : null;
}
