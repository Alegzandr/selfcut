/**
 * How far before a slice of the export mix its render starts.
 *
 * Each slice is its own `OfflineAudioContext`, and every clip and lane effect
 * is rebuilt in it from nothing: an echo or a reverb that rang past the end of
 * the previous slice was cut there, and a compressor re-attacked at every
 * boundary - an audible tick every five seconds. Rendering a stretch of the mix
 * ahead of the slice and throwing it away lets each of them reach the slice in
 * the state one continuous render would have left it in.
 *
 * Sized on the longest tail an effect has (see `audioFx`): the echo at its
 * strongest feeds back 0.6 every 0.3 s, so 4 s is thirteen repeats, down
 * near -60 dB - past the 1.6 s reverb and the compressor's 0.2 s release.
 */
export const AUDIO_PREROLL_SECONDS = 4;

/** What to render for the slice of `frames` at `offset`, and what to keep of it. */
export interface PreRolledSlice {
  /** First frame rendered, into the exported span. */
  renderOffset: number;
  /** Frames rendered: the pre-roll, then the slice. */
  renderFrames: number;
  /** Leading frames of the render to drop: the slice starts here. */
  discard: number;
}

/**
 * Widen a slice with its pre-roll, sample-exact.
 *
 * Never reaches before the start of the exported span: a region's first slice
 * starts from silence, exactly as the preview does when it plays from the in
 * point.
 */
export function preRolledSlice(
  offset: number,
  frames: number,
  preRollFrames: number,
): PreRolledSlice {
  const discard = Math.max(0, Math.min(offset, Math.floor(preRollFrames)));
  return { renderOffset: offset - discard, renderFrames: frames + discard, discard };
}
