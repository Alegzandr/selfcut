import type { LoopRegion, MediaAsset, Project } from '../../types';
import { forEachProjectClip, isTrackAudible, projectDurationMs } from '../../model';
import { t } from '../../i18n';
import { flushProjectSave } from '../../lib/persistence';
import { trackDisplayName } from '../../timeline/trackName';
import { projectExportFps } from '../presets';
import { ExportCanceledError, renderMixWav } from '../exporter';
import { buildXmeml } from './xmeml';
import { buildZip, MAX_ZIP_BYTES, ZipTooLargeError, type ZipEntry } from './zip';
import { cleanName, rushNames, stemProject } from './folder';
import { disconnectedSourceNames, exportSpan } from '../span';

/**
 * "For my editor": the cut as a folder an editor on Premiere or DaVinci can
 * pick up, rather than a finished render they cannot re-cut.
 *
 * One ZIP holding:
 * - the sequence as FCP7 XML (both NLEs import it), pointing at the rushes;
 * - one 24-bit WAV per lane that makes sound, mixed exactly as SelfCut plays
 *   it (clip and lane gains, fades, effects) and never normalized, so the
 *   stems sum back to the mix and the editor keeps the headroom;
 * - optionally the rushes themselves, under the names the XML uses;
 * - a read-me saying what is in it and what did not travel.
 */

export interface HandoffOptions {
  /** Base name of the folder and of the sequence, without extension. */
  baseName: string;
  region: LoopRegion | null;
  includeRushes: boolean;
}

export interface HandoffResult {
  blob: Blob;
  filename: string;
  stems: number;
}

export interface HandoffHandle {
  promise: Promise<HandoffResult>;
  cancel: () => void;
}

export function startHandoff(
  project: Project,
  assets: Record<string, MediaAsset>,
  options: HandoffOptions,
  onProgress: (value: number) => void,
): HandoffHandle {
  let canceled = false;
  const isCanceled = () => canceled;
  const canceledError = () => new ExportCanceledError(t('errors.export.canceled'));

  const promise = (async (): Promise<HandoffResult> => {
    flushProjectSave();
    if (projectDurationMs(project) <= 0) throw new Error(t('errors.export.emptyProject'));
    const { startMs, durationMs } = exportSpan(project, options.region);
    if (durationMs <= 0) throw new Error(t('errors.export.emptyRegion'));
    const disconnected = disconnectedSourceNames(project, assets);
    if (disconnected.length > 0) {
      throw new Error(t('errors.export.disconnectedSources', { names: disconnected.join(', ') }));
    }

    const base = cleanName(options.baseName) || 'selfcut';
    const fps = projectExportFps(project, assets);

    // Names first: the XML and the rushes folder must agree on every one.
    const referenced: MediaAsset[] = [];
    const seen = new Set<string>();
    forEachProjectClip(project, (clip) => {
      const asset = assets[clip.assetId];
      if (asset && !seen.has(asset.id)) {
        seen.add(asset.id);
        referenced.push(asset);
      }
    });
    const names = rushNames(referenced, options.includeRushes);
    const sequence = buildXmeml({
      project,
      assets,
      fps,
      startMs,
      durationMs,
      sequenceName: base,
      mediaName: (asset) => names.get(asset.id) ?? asset.file.name,
    });
    onProgress(0.05);

    // Refuse a folder that cannot fit before spending minutes on its stems:
    // the rushes are known, and each stem is 48 kHz stereo 24-bit at most.
    const lanesAudible = project.tracks.filter((track) => isTrackAudible(track, project.tracks));
    const rushBytes = options.includeRushes
      ? sequence.usedAssetIds.reduce((n, id) => n + (assets[id]?.file.size ?? 0), 0)
      : 0;
    const stemBytes = lanesAudible.length * (durationMs / 1000) * 48_000 * 2 * 3;
    if (rushBytes + stemBytes > MAX_ZIP_BYTES) throw new Error(t('errors.handoff.tooLarge'));

    // One stem per root lane that the mix actually plays. A lane silenced by
    // mute or by someone else's solo is not in the mix, so not in the stems:
    // the stems must sum back to what the user hears.
    const lanes = lanesAudible;
    const entries: ZipEntry[] = [];
    const STEM_SHARE = options.includeRushes ? 0.6 : 0.85;
    let stems = 0;
    for (let i = 0; i < lanes.length; i++) {
      if (canceled) throw canceledError();
      const track = lanes[i]!;
      const ordinal = project.tracks.filter((tr) => tr.kind === track.kind).indexOf(track) + 1;
      const wav = await renderMixWav(stemProject(project, track), assets, startMs, durationMs, isCanceled, (v) =>
        onProgress(0.05 + ((i + v) / lanes.length) * STEM_SHARE),
      );
      if (!wav) continue;
      const label = t(track.kind === 'video' ? 'track.label.video' : 'track.label.audio', { n: ordinal });
      const display = cleanName(trackDisplayName(track, ordinal, t));
      const fileName = display && display !== label ? `${label} - ${display}` : label;
      entries.push({ name: `${t('handoff.folder.audio')}/${fileName}.wav`, data: wav });
      stems++;
    }

    if (options.includeRushes) {
      for (const assetId of sequence.usedAssetIds) {
        const asset = assets[assetId]!;
        entries.push({ name: `${t('handoff.folder.rushes')}/${names.get(assetId)!}`, data: asset.file });
      }
    }

    const readme = [
      t('handoff.readme.title', { name: base }),
      '',
      t('handoff.readme.xml', { file: `${base}.xml`, fps }),
      stems > 0 ? t('handoff.readme.stems', { count: stems, folder: t('handoff.folder.audio') }) : t('handoff.readme.noStems'),
      options.includeRushes
        ? t('handoff.readme.rushes', { folder: t('handoff.folder.rushes') })
        : t('handoff.readme.relink'),
      ...(sequence.omitted.generated > 0 ? [t('handoff.readme.generated', { count: sequence.omitted.generated })] : []),
      ...(sequence.omitted.ramped > 0 ? [t('handoff.readme.ramped', { count: sequence.omitted.ramped })] : []),
      '',
      t('handoff.readme.premiere'),
      t('handoff.readme.resolve'),
      '',
    ].join('\r\n');

    entries.unshift(
      { name: `${base}.xml`, data: new Blob([sequence.xml], { type: 'application/xml' }) },
      { name: `${t('handoff.readme.fileName')}.txt`, data: new Blob([readme], { type: 'text/plain' }) },
    );

    const zipBase = 0.05 + STEM_SHARE;
    let blob: Blob;
    try {
      blob = await buildZip(entries, isCanceled, (v) => onProgress(zipBase + v * (1 - zipBase)));
    } catch (err) {
      if (err instanceof ZipTooLargeError) throw new Error(t('errors.handoff.tooLarge'), { cause: err });
      if (err instanceof DOMException && err.name === 'AbortError') throw canceledError();
      throw err;
    }
    onProgress(1);
    return { blob, filename: `${base}.zip`, stems };
  })();

  return {
    promise,
    cancel: () => {
      canceled = true;
    },
  };
}
