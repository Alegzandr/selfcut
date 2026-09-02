import type { TFunction } from 'i18next';
import type { Track } from '../types';

/**
 * What a track is called on screen: its user-given name, or the positional
 * "V1" / "A2" every NLE falls back to. One function so the header, the row's
 * accessible name and the track menu can never disagree.
 */
export function trackDisplayName(track: Track, ordinal: number, t: TFunction): string {
  if (track.name) return track.name;
  return t(track.kind === 'video' ? 'track.label.video' : 'track.label.audio', { n: ordinal });
}
