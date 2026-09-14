import { useStore } from '../store/store';
import { findClip, linkedPartnerIds } from '../store/projectOps';
import { audioTrackForClip } from '../model';
import { isTrackPlayable, type Clip, type MediaAsset, type Project } from '../types';
import { measureClipLoudness } from '../media/clipLoudness';
import { balanceGain } from '../lib/loudness';
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
 * The clip whose volume carries `clipId`'s sound: the audio member of its link
 * group when it has one (the video side is silent in the mix, so setting its
 * volume would balance nothing), else the clip itself. Scoped to the clip's
 * own composition through `linkedPartnerIds`.
 */
function audioClipFor(project: Project, clipId: string): Clip | null {
  const found = findClip(project, clipId);
  if (!found) return null;
  if (found.track.kind === 'audio' || !found.clip.linkId) return found.clip;
  for (const pid of linkedPartnerIds(project, clipId)) {
    const partner = findClip(project, pid);
    if (partner && partner.track.kind === 'audio') return partner.clip;
  }
  return found.clip;
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
 * The clips an auto-balance aimed at `clipIds` will actually measure, deduped
 * and resolved to their audio side. Exported for the command's enabled flag,
 * so a menu row is greyed out exactly when pressing it would say "nothing to
 * measure".
 */
export function balanceTargets(
  project: Project,
  assets: Record<string, MediaAsset>,
  clipIds: readonly string[],
): { clip: Clip; asset: MediaAsset }[] {
  const seen = new Set<string>();
  const out: { clip: Clip; asset: MediaAsset }[] = [];
  for (const id of clipIds) {
    const clip = audioClipFor(project, id);
    if (!clip || seen.has(clip.id)) continue;
    seen.add(clip.id);
    const asset = assets[clip.assetId];
    if (measurable(clip, asset)) out.push({ clip, asset });
  }
  return out;
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
    let limited = 0;
    for (const { clip, asset } of targets) {
      const measured = await measureClipLoudness(asset, clip);
      const decision = measured && balanceGain(measured);
      // Silence, or nothing decodable: left where it is. Lifting an empty
      // room by +12 dB is not balance.
      if (!decision) continue;
      volumes[clip.id] = decision.gain;
      if (decision.limited) limited++;
    }
    const count = Object.keys(volumes).length;
    if (count === 0) {
      useStore.getState().setError(t('errors.volume.balance.none'));
      return;
    }
    useStore.getState().setClipVolumes(volumes);
    useStore
      .getState()
      .setNotice(
        limited > 0
          ? t('volume.balance.doneLimited', { count, limited })
          : t('volume.balance.done', { count }),
      );
  } catch (err) {
    console.warn('[volume] auto-balance failed:', err);
    useStore.getState().setError(t('errors.volume.balance.failed'));
  } finally {
    useStore.getState().setVolumeBalancing(false);
  }
}
