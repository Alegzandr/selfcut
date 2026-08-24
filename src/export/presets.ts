import { AspectRatio, MediaAsset, Project } from '../types';
import { audioTrackForClip } from '../model';
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

/**
 * Video codecs an MP4 export can be encoded with.
 *
 * H.264 is the floor: it plays everywhere, hardware-encodes everywhere, and is
 * what every platform ingests. The other two exist because they are worth
 * roughly half the bitrate for the same picture, which on a client-side editor
 * is not an abstraction - it is the size of the file the user has to upload,
 * and the number of bytes the encoder has to write to their disk.
 *
 * A preset asking for a codec this browser cannot encode falls back to H.264
 * rather than failing (see the probe in the export worker), so a codec choice
 * is always a preference and never a way to make an export impossible.
 */
export type ExportVideoCodec = 'avc' | 'hevc' | 'av1';

/** How an MP4 preset settles its frame rate. */
export type FpsMode =
  /** Follow the footage: the fastest source rate on the timeline (see projectExportFps). */
  | 'source'
  /**
   * The preset's rate is a CEILING, and the footage decides below it.
   *
   * For the delivery presets - the 120 fps family, the masters - whose whole
   * point is a high cadence, but which have no business inventing one the
   * timeline cannot supply. A 1080p60 source exported by "120 fps - 4K" was
   * encoding every frame twice: twice the frames, twice the encode, twice the
   * bytes, and not one additional instant of what was filmed.
   *
   * It is not free. Keyframed motion - a zoom animation, a moving text - IS
   * sampled at output time, so it genuinely is smoother at 120 than at 60 even
   * over 60 fps rushes. What that buys is judged not to be worth doubling the
   * cost of every render whose footage cannot use it; a preset that must have
   * its cadence regardless says `fixed`.
   */
  | 'capped'
  /** Pinned by the preset whatever the footage - the whole point of a 24p export. */
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
  /**
   * Codec to encode with. Absent means H.264, which is what every preset saved
   * or shared before the choice existed meant.
   */
  codec?: ExportVideoCodec;
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
  /** Codec for this format; absent means H.264. */
  codec?: ExportVideoCodec;
  /** Pinned or ceiling frame rate, or null to follow the footage like the social presets. */
  fps: number | null;
  /**
   * How `fps` is meant. Omitted means `capped` whenever a rate is given: a
   * delivery preset names the cadence it is FOR, and inventing frames the
   * footage does not have was never part of that. Only a preset whose cadence
   * is the point regardless of the rushes - 24p - says `fixed`.
   */
  fpsMode?: FpsMode;
}

const CUSTOM_FORMATS: readonly CustomFormat[] = [
  {
    // Modern codecs, offered as a pair rather than as a setting: what an editor
    // wants to choose is "the smallest file that still looks right", not a
    // codec name. Both fall back to H.264 where the browser cannot encode them,
    // so picking one is never a way to make an export fail.
    //
    // The bitrate scales are the conservative end of the published figures:
    // HEVC is usually quoted at 40-50% of H.264 for equal quality and AV1 below
    // that, and asking for 60% and 50% leaves headroom for the hardware
    // encoders, which are tuned for speed rather than for the last few percent.
    id: 'hevc1080',
    labelKey: 'export.preset.hevc1080.label',
    hintKey: 'export.preset.hevc1080.hint',
    tier: '1080',
    bitrateScale: 0.6,
    fps: null,
    codec: 'hevc',
  },
  {
    id: 'av1_1080',
    labelKey: 'export.preset.av1_1080.label',
    hintKey: 'export.preset.av1_1080.hint',
    tier: '1080',
    bitrateScale: 0.5,
    fps: null,
    codec: 'av1',
  },
  {
    // ~1.35x YouTube's top 4K figure: past the point a platform asks for, which
    // is exactly what a master meant for re-grading or archiving wants.
    //
    // The cadence is a CEILING at the full project rate, not a pin. A master is
    // the copy every later export is cut from, so it asks for the highest
    // cadence the timeline can carry - but "can carry" is the operative half:
    // over 24 fps rushes, the 60 fps it used to pin wrote every frame between
    // two and a half copies of a frame that was already there.
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
    // Same ceiling as the 4K master, for the same reason.
    id: 'master1080',
    labelKey: 'export.preset.master1080.label',
    hintKey: 'export.preset.master1080.hint',
    tier: '1080',
    bitrateScale: 3,
    fps: PROJECT_FPS,
  },
  // The 120 fps family: a hand-off, not a final cut. Above the export ladder on
  // purpose - but as a ceiling, since 120 fps of source only exists for
  // high-rate footage or slowed clips. Keyframed motion IS sampled at output
  // time and so is genuinely smoother at 120 even over 60 fps rushes; that is
  // real, and it is not judged worth doubling the encode and the file size of
  // every render whose footage cannot use it (see the `capped` FpsMode).
  // Offered at three rungs because the file is meant to leave the
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
    // The one rate that is a LOOK rather than a ceiling. 24p is what the preset
    // is for, and it is below every source rate anyway, so capping would never
    // fire - saying so is what keeps the next reader from "tidying" it away.
    fpsMode: 'fixed',
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
        fpsMode: format.fpsMode,
        codec: format.codec,
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
  fpsMode?: FpsMode;
  codec?: ExportVideoCodec;
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
    fpsMode: spec.fps === null ? 'source' : (spec.fpsMode ?? 'capped'),
    videoBitrate: Math.round(videoBitrate * spec.bitrateScale),
    ...(spec.codec ? { codec: spec.codec } : {}),
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
  const fastest = projectSourceFps(project, assets);
  return fastest > 0 ? normalizeExportFps(fastest) : PROJECT_FPS;
}

/**
 * The fastest MEASURED source frame rate on the timeline, or 0 when nothing on
 * it states one (a generated-only project, or assets imported before frame-rate
 * probing).
 *
 * Raw, unsnapped and uncapped, unlike `projectExportFps`: the ladder that
 * function applies tops out at the project rate, which is the right answer for
 * a preset following the footage and the wrong one for a ceiling. A 120 fps
 * source under a 120 fps ceiling has to be able to come back as 120.
 *
 * Zero is a real answer and not an error: it means "unknown", and every caller
 * treats it as "do not adapt" rather than as a rate.
 */
export function projectSourceFps(project: Project, assets: Record<string, MediaAsset>): number {
  let fastest = 0;
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'media') continue;
      const fps = assets[clip.assetId]?.fps;
      if (fps && fps > fastest) fastest = fps;
    }
  }
  return fastest;
}

/**
 * Rates a CEILING preset may settle on.
 *
 * The adaptive ladder plus the two high-cadence rungs, because this one is
 * bounded by the preset rather than by the project rate: a 120 fps ceiling over
 * 120 fps footage must be able to answer 120, which `EXPORT_FPS_LADDER` cannot
 * express. Snapping still matters for the same reason it does there - 119.88
 * is 120, and encoding it as 119.88 helps nobody.
 */
const CAPPED_FPS_LADDER = [24, 25, 30, 50, 60, 100, 120] as const;

/** Snap a measured source rate to the nearest rate a ceiling preset exports at. */
function snapCappedFps(sourceFps: number): number {
  return CAPPED_FPS_LADDER.reduce((best, rate) =>
    Math.abs(rate - sourceFps) < Math.abs(best - sourceFps) ? rate : best,
  );
}

/**
 * The rate this preset will actually encode at on this timeline.
 *
 * Three modes, three answers: follow the footage, honour the preset, or take
 * the lower of the two. The ceiling case falls back to the preset's own rate
 * when nothing on the timeline states a frame rate - an unknown source is not
 * evidence of a slow one, and guessing low would quietly downgrade a delivery
 * export over missing metadata.
 */
export function resolveExportFps(
  preset: Mp4Preset,
  project: Project,
  assets: Record<string, MediaAsset>,
  opts?: ResolveOptions,
): number {
  if (preset.fpsMode === 'fixed') return preset.fps;
  if (preset.fpsMode === 'source') return projectExportFps(project, assets);
  if (opts?.forceMaxFps) return preset.fps;
  const source = projectSourceFps(project, assets);
  if (source <= 0) return preset.fps;
  return Math.min(preset.fps, snapCappedFps(source));
}

/** Choices the user made in the export sheet that change how a preset resolves. */
export interface ResolveOptions {
  /**
   * Encode at the preset's full cadence even where the footage cannot fill it.
   *
   * The escape hatch for the one thing the cap genuinely costs: keyframed
   * motion - a zoom, a moving title - is sampled at OUTPUT time, so it really
   * is smoother at 120 fps over 60 fps rushes. Everything else about those
   * extra frames is duplication, which is why this is a checkbox and not the
   * default.
   *
   * Only ever offered where it changes something (see `fpsCapBinds`).
   */
  forceMaxFps?: boolean;
}

/**
 * Whether this preset's cadence ceiling is actually holding this project back.
 *
 * What the export sheet asks before offering to override it: a checkbox that
 * cannot change the outcome is a question the user has to read, answer and be
 * wrong about for nothing.
 */
export function fpsCapBinds(
  preset: Mp4Preset,
  project: Project,
  assets: Record<string, MediaAsset>,
): boolean {
  return preset.fpsMode === 'capped' && resolveExportFps(preset, project, assets) < preset.fps;
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
  opts?: ResolveOptions,
): Mp4Preset {
  const fps = resolveExportFps(preset, project, assets, opts);
  return {
    ...preset,
    fps,
    videoBitrate: videoBitrateForFps(preset, fps),
    audioBitrate: audioBitrateForProject(preset.audioBitrate, project, assets),
  };
}

/**
 * What a stereo AAC target is worth once the mix is known to be mono.
 *
 * Not a half. Joint stereo already codes two identical channels far more
 * cheaply than two different ones, so the honest saving is the difference
 * between a genuine stereo image and none - the usual published figure for
 * equal quality is around 60%, and erring high costs a few bytes where erring
 * low costs audible quality.
 */
const MONO_AUDIO_SCALE = 0.6;

/**
 * The audio bitrate to encode this timeline at, never above what the preset
 * asks for.
 *
 * The preset's figure describes the best case its destination wants - 384 kbps
 * stereo, YouTube's recommendation - and spending it on a mix that cannot carry
 * a stereo image is spending it on nothing. Only ONE conclusion is drawn here,
 * and only when it is certain: every audible clip is mono at the source or
 * downmixed to mono, and none of them is panned, so the two output channels are
 * bit-identical.
 *
 * Deliberately conservative in the other direction. The mix itself stays stereo
 * (`prepareAudioMix` renders two channels whatever this returns), a source
 * without stated channels counts as stereo, and anything uncertain keeps the
 * preset's figure: a file that is slightly larger than it needed to be is a
 * non-event, and one that is quietly worse than the preset promised is not.
 *
 * What is NOT adapted, for lack of evidence rather than lack of will: the
 * source's own bitrate. `AudioTrackInfo` records channels and sample rate at
 * probe time and not the rate the track was encoded at, so there is nothing
 * here to tell a 96 kbps podcast from a 320 kbps master.
 */
export function audioBitrateForProject(
  presetBitrate: number,
  project: Project,
  assets: Record<string, MediaAsset>,
): number {
  let audible = false;
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'media' || clip.volume <= 0) continue;
      const asset = assets[clip.assetId];
      if (!asset?.hasAudio) continue;
      audible = true;
      // Panned: the channels differ however mono the source was.
      if (clip.pan) return presetBitrate;
      if (clip.mono) continue;
      // Through the shared helper, never a hand-rolled lookup: it is what the
      // mix itself resolves a clip's track with, and a preset that disagreed
      // would describe a different track than the one being encoded.
      const source = audioTrackForClip(asset, clip);
      // Unknown track, or more than one channel: assume a real stereo image.
      if (!source || source.channels > 1) return presetBitrate;
    }
  }
  return audible ? Math.round(presetBitrate * MONO_AUDIO_SCALE) : presetBitrate;
}

export function exportFileName(preset: ExportPreset): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = preset.kind === 'mp3' ? 'mp3' : 'mp4';
  return `${APP_NAME.toLowerCase()}-${preset.id}-${stamp}.${ext}`;
}
