import { AspectRatio, MediaAsset, Project } from '../types';
import { APP_NAME, PROJECT_FPS } from '../app/config';
import type { ParseKeys } from 'i18next';

/**
 * Sections of the export sheet. `social` holds the platform-shaped presets,
 * `custom` the off-the-shelf ones an editor eventually asks for (a 120 fps
 * cadence, a 4K master, a file small enough to email), `audio` the audio-only
 * exports.
 */
export type PresetGroup = 'social' | 'custom' | 'audio';

interface BaseExportPreset {
  id: string;
  group: PresetGroup;
  /**
   * Translation keys, not strings: the module is evaluated once at import time,
   * while the locale can still change afterwards. The UI resolves them at render
   * (`description` interpolates `{{fps}}`).
   */
  labelKey: ParseKeys;
  descriptionKey: ParseKeys;
  /** Optional quality shown next to the format name in the export sheet. */
  qualityKey?: ParseKeys;
  /**
   * Optional third line: what the preset is *for*. The social presets need none
   * (their name is the destination); a custom one is only pickable if the sheet
   * says what it buys.
   */
  hintKey?: ParseKeys;
  audioBitrate: number;
}

/** How an MP4 preset settles its frame rate. */
export type FpsMode =
  /** Follow the footage: the fastest source rate on the timeline (see projectExportFps). */
  | 'source'
  /** Pinned by the preset whatever the footage - the whole point of a 120 fps or a 24p export. */
  | 'fixed';

/** A video export: carries the frame geometry and bitrate the worker needs. */
export interface Mp4Preset extends BaseExportPreset {
  kind: 'mp4';
  /** MP4 presets are tied to a project aspect ratio. */
  aspect: AspectRatio;
  width: number;
  height: number;
  fps: number;
  fpsMode: FpsMode;
  videoBitrate: number;
}

/** An audio-only export: fits any aspect ratio, no video geometry. */
export interface Mp3Preset extends BaseExportPreset {
  kind: 'mp3';
}

/**
 * Discriminated on `kind`: the video fields (width/height/fps/videoBitrate) only
 * exist on MP4 presets, so the worker never needs a non-null assertion and MP3
 * presets can't carry a meaningless fps.
 */
export type ExportPreset = Mp4Preset | Mp3Preset;

/** Resolution rungs every aspect ratio is described at. */
type VideoTier = '720' | '1080' | '1440' | '4k';

interface TierSpec {
  width: number;
  height: number;
  /**
   * HIGH-frame-rate (48-60 fps) figure; a standard-rate export scales it down
   * (see videoBitrateForFps). The references are YouTube's published SDR
   * recommendations: 720p 7.5, 1080p 12, 1440p 24, 4K 53-68 Mbps. Vertical and
   * square rungs mirror the equivalent pixel counts; the platforms cap display
   * at 1080p and re-encode, so a generous source only improves their output.
   */
  videoBitrate: number;
}

/**
 * Geometry and reference bitrate per aspect ratio, per rung. Both preset
 * families read from here - the social ones take a rung as it is, the custom
 * ones scale its bitrate - so a resolution is described in exactly one place.
 */
const TIERS: Record<AspectRatio, Record<VideoTier, TierSpec>> = {
  '16:9': {
    '720': { width: 1280, height: 720, videoBitrate: 7_500_000 },
    '1080': { width: 1920, height: 1080, videoBitrate: 12_000_000 },
    '1440': { width: 2560, height: 1440, videoBitrate: 24_000_000 },
    '4k': { width: 3840, height: 2160, videoBitrate: 60_000_000 },
  },
  '9:16': {
    '720': { width: 720, height: 1280, videoBitrate: 7_500_000 },
    '1080': { width: 1080, height: 1920, videoBitrate: 12_000_000 },
    '1440': { width: 1440, height: 2560, videoBitrate: 24_000_000 },
    '4k': { width: 2160, height: 3840, videoBitrate: 60_000_000 },
  },
  '1:1': {
    '720': { width: 720, height: 720, videoBitrate: 5_000_000 },
    '1080': { width: 1080, height: 1080, videoBitrate: 8_000_000 },
    '1440': { width: 1440, height: 1440, videoBitrate: 16_000_000 },
    '4k': { width: 2160, height: 2160, videoBitrate: 35_000_000 },
  },
  '4:5': {
    '720': { width: 576, height: 720, videoBitrate: 5_000_000 },
    '1080': { width: 1080, height: 1350, videoBitrate: 9_000_000 },
    '1440': { width: 1152, height: 1440, videoBitrate: 16_000_000 },
    '4k': { width: 2160, height: 2700, videoBitrate: 40_000_000 },
  },
};

/**
 * Aspect ratios the custom presets are generated for. Read off `TIERS` rather
 * than listed again, so an aspect ratio can never have rungs but no custom
 * presets (`TIERS` is typed exhaustively over the union).
 */
const ASPECTS = Object.keys(TIERS) as AspectRatio[];

/** One social destination: its label, its aspect ratio, and the rungs it offers. */
const SOCIAL_FORMATS: readonly {
  id: string;
  labelKey: ParseKeys;
  aspect: AspectRatio;
}[] = [
  { id: 'youtube', labelKey: 'export.preset.youtube.label', aspect: '16:9' },
  { id: 'tiktok', labelKey: 'export.preset.tiktok.label', aspect: '9:16' },
  { id: 'square', labelKey: 'export.preset.square.label', aspect: '1:1' },
  { id: 'portrait45', labelKey: 'export.preset.portrait45.label', aspect: '4:5' },
];

const SOCIAL_TIERS: readonly VideoTier[] = ['720', '1080', '1440', '4k'];

/**
 * A custom preset, described once and instantiated for every aspect ratio: none
 * of them targets a platform, so all four project shapes get the same list.
 */
interface CustomFormat {
  id: string;
  labelKey: ParseKeys;
  hintKey: ParseKeys;
  /**
   * Optional resolution shown next to the name, exactly like a social preset's.
   * A custom preset offered at several rungs (the 120 fps delivery family) needs
   * it: the label alone names the cadence, not which of the three rows it is.
   */
  qualityKey?: ParseKeys;
  tier: VideoTier;
  /**
   * Multiplier on the rung's reference bitrate. 1 is "what a platform upload
   * wants"; above it buys headroom for re-editing, below it buys a small file.
   */
  bitrateScale: number;
  /** Pinned frame rate, or null to follow the footage like the social presets. */
  fps: number | null;
}

const CUSTOM_FORMATS: readonly CustomFormat[] = [
  {
    // ~1.35x YouTube's top 4K figure: past the point a platform asks for, which
    // is exactly what a master meant for re-grading or archiving wants. Pinned
    // at the full project rate for the same reason: a master is the copy every
    // later export is cut from, so it holds the highest cadence the timeline
    // can carry rather than the one this particular set of rushes implies.
    id: 'ultra4k',
    labelKey: 'export.preset.ultra4k.label',
    hintKey: 'export.preset.ultra4k.hint',
    tier: '4k',
    bitrateScale: 1.35,
    fps: PROJECT_FPS,
  },
  {
    // 3x an upload's 1080p bitrate: generational loss stops being visible, so
    // the file can be re-cut or re-encoded later without stacking artefacts.
    // Same pinned rate as the 4K master, for the same reason.
    id: 'master1080',
    labelKey: 'export.preset.master1080.label',
    hintKey: 'export.preset.master1080.hint',
    tier: '1080',
    bitrateScale: 3,
    fps: PROJECT_FPS,
  },
  // The 120 fps family: a hand-off, not a final cut. Above the export ladder on
  // purpose (source frames only exist at 120 fps for high-rate footage or slowed
  // clips, but keyframed motion is sampled at output time, so it does get
  // smoother), and offered at three rungs because the file is meant to leave the
  // app and be re-cut - the editor receiving it picks the resolution, and a
  // single 1080p row forced everyone through the smallest one.
  //
  // The bitrates are twice the platform-upload figure for the rung, on top of
  // the cadence surcharge videoBitrateForFps adds past 90 fps. That lands each
  // rung near 0.15 bit per pixel per frame: enough that a re-encode downstream -
  // a 4x slow motion, a re-grade, a second export - does not stack visible
  // artefacts, and still small enough to actually upload. Anything more would be
  // a mezzanine codec's job, not H.264's.
  {
    id: 'smooth120-1080',
    labelKey: 'export.preset.smooth120.label',
    hintKey: 'export.preset.smooth120.hint',
    qualityKey: 'export.quality.1080',
    tier: '1080',
    bitrateScale: 2,
    fps: 120,
  },
  {
    id: 'smooth120-1440',
    labelKey: 'export.preset.smooth120.label',
    hintKey: 'export.preset.smooth120.hint',
    qualityKey: 'export.quality.1440',
    tier: '1440',
    // Slightly under the 1080p multiplier, and 1.4 at 4K: a bigger frame codes
    // more efficiently per pixel, so holding the same bitrate scale at every
    // rung would overspend at the top exactly where the file is already heaviest.
    bitrateScale: 1.8,
    fps: 120,
  },
  {
    id: 'smooth120-4k',
    labelKey: 'export.preset.smooth120.label',
    hintKey: 'export.preset.smooth120.hint',
    qualityKey: 'export.quality.4k',
    tier: '4k',
    bitrateScale: 1.4,
    fps: 120,
  },
  {
    // Film cadence, whatever the timeline holds. Doubled rung bitrate so the
    // 24 fps scaling below still lands well above an upload's figure.
    id: 'cinema24',
    labelKey: 'export.preset.cinema24.label',
    hintKey: 'export.preset.cinema24.hint',
    tier: '1080',
    bitrateScale: 2,
    fps: 24,
  },
  {
    // Full resolution at a fraction of the bitrate: stays sharp on a phone and
    // clears the size limits of messaging apps and mail attachments.
    id: 'light1080',
    labelKey: 'export.preset.light1080.label',
    hintKey: 'export.preset.light1080.hint',
    tier: '1080',
    bitrateScale: 0.4,
    fps: null,
  },
];

export const PRESETS: ExportPreset[] = [
  ...SOCIAL_FORMATS.flatMap((format) =>
    SOCIAL_TIERS.map((tier) =>
      videoPreset({
        id: `${format.id}-${tier}`,
        group: 'social',
        labelKey: format.labelKey,
        qualityKey: `export.quality.${tier}` as ParseKeys,
        aspect: format.aspect,
        tier,
        bitrateScale: 1,
        fps: null,
      }),
    ),
  ),
  ...CUSTOM_FORMATS.flatMap((format) =>
    ASPECTS.map((aspect) =>
      videoPreset({
        // The aspect ratio is part of the id: unlike a social preset, whose name
        // implies one shape, every custom preset exists for all four.
        id: `${format.id}-${aspect.replace(':', 'x')}`,
        group: 'custom',
        labelKey: format.labelKey,
        hintKey: format.hintKey,
        qualityKey: format.qualityKey,
        aspect,
        tier: format.tier,
        bitrateScale: format.bitrateScale,
        fps: format.fps,
      }),
    ),
  ),
  ...audioPresets('mp3', [
    ['128', 128_000],
    ['192', 192_000],
    ['320', 320_000],
  ]),
];

type AudioQuality = readonly [id: '128' | '192' | '320', bitrate: number];

function videoPreset(spec: {
  id: string;
  group: PresetGroup;
  labelKey: ParseKeys;
  qualityKey?: ParseKeys;
  hintKey?: ParseKeys;
  aspect: AspectRatio;
  tier: VideoTier;
  bitrateScale: number;
  fps: number | null;
}): Mp4Preset {
  const { width, height, videoBitrate } = TIERS[spec.aspect][spec.tier];
  return {
    id: spec.id,
    group: spec.group,
    labelKey: spec.labelKey,
    descriptionKey: 'export.preset.video.description',
    qualityKey: spec.qualityKey,
    hintKey: spec.hintKey,
    kind: 'mp4',
    aspect: spec.aspect,
    width,
    height,
    fps: spec.fps ?? PROJECT_FPS,
    fpsMode: spec.fps === null ? 'source' : 'fixed',
    videoBitrate: Math.round(videoBitrate * spec.bitrateScale),
    // 384 kbps AAC-LC stereo @ 48 kHz — YouTube's recommended audio spec, high
    // enough that the platforms' re-encode stays clean.
    audioBitrate: 384_000,
  };
}


function audioPresets(id: string, qualities: readonly AudioQuality[]): Mp3Preset[] {
  return qualities.map(([quality, audioBitrate]) => ({
    id: `${id}-${quality}`,
    group: 'audio',
    labelKey: 'export.preset.mp3.label',
    descriptionKey: 'export.preset.audio.description',
    qualityKey: `export.quality.mp3_${quality}` as ParseKeys,
    kind: 'mp3',
    audioBitrate,
  }));
}

export function presetsForAspect(aspect: AspectRatio): ExportPreset[] {
  return PRESETS.filter((p) => p.kind === 'mp3' || p.aspect === aspect);
}

/** One section of the export sheet: a group title and the presets under it. */
export interface PresetSection {
  group: PresetGroup;
  titleKey: ParseKeys;
  presets: ExportPreset[];
}

const GROUP_TITLES: Record<PresetGroup, ParseKeys> = {
  social: 'export.group.social',
  custom: 'export.group.custom',
  audio: 'export.group.audio',
};

/** Display order of the sections: the platform presets stay the first thing seen. */
const GROUP_ORDER: readonly PresetGroup[] = ['social', 'custom', 'audio'];

/**
 * The export sheet's sections for a project shape, in display order. Flattening
 * these back yields `presetsForAspect`'s order, so the default selection (the
 * first preset) is the first row shown.
 */
export function presetSectionsForAspect(aspect: AspectRatio): PresetSection[] {
  const presets = presetsForAspect(aspect);
  return GROUP_ORDER.map((group) => ({
    group,
    titleKey: GROUP_TITLES[group],
    presets: presets.filter((p) => p.group === group),
  })).filter((section) => section.presets.length > 0);
}

/**
 * Frame rates an adaptive export is snapped to. Capped at the project rate (60):
 * following the footage never synthesizes frames the timeline doesn't have.
 * NTSC rates (23.976, 29.97, 59.94) land on their integer neighbour. A
 * `fixed`-rate preset deliberately bypasses the ladder - asking for 120 fps,
 * for 24p, or for a 60 fps master is asking to resample.
 */
const EXPORT_FPS_LADDER = [24, 25, 30, 50, 60] as const;

/** YouTube's split: at/above 48 fps an upload wants the full "high frame rate" bitrate. */
const HIGH_FPS_THRESHOLD = 48;

/**
 * Past this, a cadence is beyond anything the platform figures describe - only
 * the 120 fps delivery presets get there.
 */
const VERY_HIGH_FPS_THRESHOLD = 90;

/**
 * What doubling the cadence past the 48-60 fps reference costs. Not 2x: at
 * 120 fps consecutive frames are twice as alike, so inter prediction absorbs
 * part of the extra ones. ~1.6x is the usual figure, and it is what keeps a
 * 120 fps file at the same per-FRAME quality as the 60 fps figure it is scaled
 * from - which is the whole point of a file someone else will slow down. Without
 * it a 120 fps export spread a 60 fps budget over twice the frames and arrived
 * visibly softer than the same preset at 60.
 */
const VERY_HIGH_FPS_SCALE = 1.6;

/** Snap a measured source frame rate to the nearest rate we export at. */
export function normalizeExportFps(sourceFps: number): number {
  if (!isFinite(sourceFps) || sourceFps <= 0) return PROJECT_FPS;
  return EXPORT_FPS_LADDER.reduce((best, rate) =>
    Math.abs(rate - sourceFps) < Math.abs(best - sourceFps) ? rate : best,
  );
}

/**
 * The frame rate to export a project at: the fastest source among its video
 * clips (so 60 fps footage stays smooth while an all-30 fps project exports at
 * 30, not an up-sampled 60), snapped to the ladder. Falls back to the project
 * rate when no source frame rate is known (generated-only project, or assets
 * imported before frame-rate probing).
 */
export function projectExportFps(project: Project, assets: Record<string, MediaAsset>): number {
  let fastest = 0;
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'media') continue;
      const fps = assets[clip.assetId]?.fps;
      if (fps && fps > fastest) fastest = fps;
    }
  }
  return fastest > 0 ? normalizeExportFps(fastest) : PROJECT_FPS;
}

/**
 * Video bitrate for a given export frame rate. Presets carry YouTube's
 * high-frame-rate figure; a standard-rate upload (24-30 fps) wants ~2/3 of it,
 * matching YouTube's own SFR/HFR split (e.g. 1080p 8 vs 12 Mbps) across every
 * resolution. Past 90 fps it scales the other way instead, so a 120 fps file
 * does not spread a 60 fps budget over twice the frames.
 */
export function videoBitrateForFps(preset: Mp4Preset, fps: number): number {
  if (fps >= VERY_HIGH_FPS_THRESHOLD) {
    return Math.round(preset.videoBitrate * VERY_HIGH_FPS_SCALE);
  }
  if (fps >= HIGH_FPS_THRESHOLD) return preset.videoBitrate;
  return Math.round((preset.videoBitrate * 2) / 3);
}

/**
 * Resolve a video preset against a project: settles the frame rate (the
 * footage's, or the preset's own when it pins one) and the bitrate that goes
 * with it. The export worker and the export sheet both go through here, so the
 * sheet always previews exactly what will be encoded.
 */
export function resolveMp4Preset(
  preset: Mp4Preset,
  project: Project,
  assets: Record<string, MediaAsset>,
): Mp4Preset {
  const fps = preset.fpsMode === 'fixed' ? preset.fps : projectExportFps(project, assets);
  return { ...preset, fps, videoBitrate: videoBitrateForFps(preset, fps) };
}

export function exportFileName(preset: ExportPreset): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = preset.kind === 'mp3' ? 'mp3' : 'mp4';
  return `${APP_NAME.toLowerCase()}-${preset.id}-${stamp}.${ext}`;
}
