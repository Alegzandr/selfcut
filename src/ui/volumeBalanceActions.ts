import { useStore } from '../store/store';
import { findClip, linkedPartnerIds } from '../store/projectOps';
import { audioTrackForClip, clipEndMs, forEachTrackSet } from '../model';
import { isTrackPlayable, type Clip, type MediaAsset, type Project, type Track } from '../types';
import { measureMixLoudness } from '../export/exporter';
import { balanceGain } from '../lib/loudness';
import { MAX_DB, MIN_DB, dbToGain } from '../lib/gain';
import { t } from '../i18n';

/**
 * Auto-balance: measure how loud each clip actually sounds and set its volume
 * so they all play at the same level.
 *
 * The one thing every cut of talking heads, phone footage and downloaded music
 * needs and nobody wants to do by ear: the interview is 12 dB under the
 * b-roll, the second camera's mic was closer, the intro track is mastered to
 * -8 LUFS. The fader is still the fader afterwards - this writes the same
 * `clip.volume` it does, in one undo step - so a clip that should sit under
 * the rest is one drag away from where it was put.
 *
 * Reachable from the Clip menu and the clip's context menu (the selection), the
 * track's context menu (the whole lane) and the inspector's Audio section.
 * They all land here so the words, the target and the undo behaviour are the
 * same whichever one was pressed.
 */

/**
 * The clips whose volumes carry `clipId`'s sound: every audio member of its
 * link group when it has some (the video side is silent in the mix, so setting
 * its volume would balance nothing, and a camera with two mics brings two of
 * them), else the clip itself. Scoped to the clip's own composition through
 * `linkedPartnerIds`.
 */
function audioClipsFor(project: Project, clipId: string): Clip[] {
  const found = findClip(project, clipId);
  if (!found) return [];
  if (!found.clip.linkId) return [found.clip];
  const members = [found.clip.id, ...linkedPartnerIds(project, clipId)]
    .map((id) => findClip(project, id))
    .filter((f): f is NonNullable<typeof f> => !!f && f.track.kind === 'audio')
    .map((f) => f.clip);
  return members.length ? members : [found.clip];
}

/** Whether there is decodable sound behind a clip to measure. */
function measurable(clip: Clip, asset: MediaAsset | undefined): asset is MediaAsset {
  if (clip.kind !== 'media' || !asset?.hasAudio) return false;
  const track = audioTrackForClip(asset, clip);
  // An asset probed before per-track info existed lists no tracks but does
  // carry sound; one whose track the browser cannot decode has nothing to read
  // until it is transcoded.
  return track ? isTrackPlayable(track) : true;
}

/**
 * What one balance acts on: the clips that sound together as one shot (a
 * link group's audio members) and get one common gain, so the balance between
 * two mics of the same take survives.
 */
export interface BalanceTarget {
  /** The first member: what the shot is named and reported by. */
  clip: Clip;
  asset: MediaAsset;
  /** Every clip whose volume the balance writes, `clip` included. */
  members: Clip[];
}

/**
 * The shots an auto-balance aimed at `clipIds` will actually measure, deduped
 * and resolved to their audio side. Exported for the command's enabled flag,
 * so a menu row is greyed out exactly when pressing it would say "nothing to
 * measure".
 */
export function balanceTargets(
  project: Project,
  assets: Record<string, MediaAsset>,
  clipIds: readonly string[],
): BalanceTarget[] {
  const seen = new Set<string>();
  const out: BalanceTarget[] = [];
  for (const id of clipIds) {
    const members = audioClipsFor(project, id).filter((c) => !seen.has(c.id) && measurable(c, assets[c.assetId]));
    if (members.length === 0) continue;
    for (const c of members) seen.add(c.id);
    out.push({ clip: members[0]!, asset: assets[members[0]!.assetId]!, members });
  }
  return out;
}

/**
 * The shot alone, as it plays: its clips at their volumes times `scale`, with
 * their mono, pan, speed and effects, and nothing of the mix around them -
 * no neighbours, no fades, no lane gain or lane effects, no mute or solo.
 * Fades are a shape over time and the lane is the user's mix: the balance sets
 * the level of the shot itself.
 */
export function isolateShot(
  project: Project,
  members: readonly Clip[],
  scale: number,
): { project: Project; startMs: number; durationMs: number } {
  const ids = new Set(members.map((c) => c.id));
  const tracks: Track[] = [];
  forEachTrackSet(project, (set) => {
    for (const track of set) {
      const clips = track.clips
        .filter((c) => ids.has(c.id))
        .map((c) => ({ ...c, volume: c.volume * scale, fadeInMs: 0, fadeOutMs: 0 }));
      if (clips.length) {
        tracks.push({ ...track, clips, muted: false, solo: false, volume: 1, audioFx: undefined });
      }
    }
  });
  const startMs = Math.min(...members.map((c) => c.timelineStartMs));
  const endMs = Math.max(...members.map(clipEndMs));
  return { project: { ...project, tracks }, startMs, durationMs: endMs - startMs };
}

/** Passes before the balance settles for what it has: a compressor converges in two. */
const MAX_PASSES = 4;
/** Close enough to the target to stop measuring. */
const SETTLED_DB = 0.1;

/**
 * Measure one shot as it plays and find the common gain that brings it to the
 * target, or null when there is nothing audible to measure.
 *
 * Iterative because what follows the fader is not always linear: a compressor
 * answers +6 dB at its input with +2 at its output, so the shot is measured
 * again at the gain just found until it lands. The peak ceiling is read off
 * the same render, so it is the peak that will actually play.
 */
async function balanceShot(
  project: Project,
  assets: Record<string, MediaAsset>,
  members: readonly Clip[],
): Promise<{ scale: number; limited: boolean } | null> {
  let scale = 1;
  let limited = false;
  let measuredOnce = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const shot = isolateShot(project, members, scale);
    const measured = await measureMixLoudness(shot.project, assets, shot.startMs, shot.durationMs);
    // Silence, or nothing decodable: left where it is. Lifting an empty room
    // by +12 dB is not balance.
    if (!measured || !isFinite(measured.lufs)) return measuredOnce ? { scale, limited } : null;
    measuredOnce = true;
    const decision = balanceGain(measured);
    if (!decision) return { scale, limited };
    // `balanceGain` answers the gain from unity; relative to the render that
    // is the change still needed.
    const deltaDb = 20 * Math.log10(decision.gain);
    limited = decision.limited;
    if (Math.abs(deltaDb) < SETTLED_DB) break;
    // The fader's own range bounds every member: past it, nothing more moves.
    const loudest = Math.max(...members.map((c) => c.volume * scale));
    const quietest = Math.min(...members.map((c) => c.volume * scale));
    let next = deltaDb;
    if (loudest > 0 && 20 * Math.log10(loudest) + next > MAX_DB) {
      next = MAX_DB - 20 * Math.log10(loudest);
      limited = true;
    }
    if (quietest > 0 && 20 * Math.log10(quietest) + next < MIN_DB) {
      next = MIN_DB - 20 * Math.log10(quietest);
      limited = true;
    }
    scale *= dbToGain(next);
    if (Math.abs(next) < SETTLED_DB) break;
  }
  return { scale, limited };
}

/**
 * Measure and balance the clips named, reporting through the toast.
 *
 * One pass at a time: the flag greys the command out while this runs, and a
 * call that finds it set does nothing rather than queue a second measurement
 * of clips whose volume the first is about to write.
 */
export async function balanceClipVolumes(clipIds: readonly string[]): Promise<void> {
  const state = useStore.getState();
  if (state.volumeBalancing) return;
  const targets = balanceTargets(state.project, state.assets, clipIds);
  if (targets.length === 0) {
    state.setError(t('errors.volume.balance.none'));
    return;
  }

  state.setVolumeBalancing(true);
  state.setNotice(t('volume.balance.running', { count: targets.length }));
  try {
    const volumes: Record<string, number> = {};
    let balanced = 0;
    let limited = 0;
    for (const { members } of targets) {
      const result = await balanceShot(state.project, state.assets, members);
      if (!result) continue;
      balanced++;
      if (result.limited) limited++;
      for (const clip of members) {
        // Quantized to the 0.1 dB every fader stores, so the inspector reads
        // back exactly what was set.
        const db = Math.min(MAX_DB, Math.max(MIN_DB, 20 * Math.log10(clip.volume * result.scale)));
        volumes[clip.id] = dbToGain(Math.round(db * 10) / 10);
      }
    }
    if (balanced === 0) {
      useStore.getState().setError(t('errors.volume.balance.none'));
      return;
    }
    useStore.getState().setClipVolumes(volumes);
    useStore
      .getState()
      .setNotice(
        limited > 0
          ? t('volume.balance.doneLimited', { count: balanced, limited })
          : t('volume.balance.done', { count: balanced }),
      );
  } catch (err) {
    console.warn('[volume] auto-balance failed:', err);
    useStore.getState().setError(t('errors.volume.balance.failed'));
  } finally {
    useStore.getState().setVolumeBalancing(false);
  }
}
