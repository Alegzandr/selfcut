import { AspectRatio } from '../types';
import { APP_NAME, PROJECT_FPS } from '../app/config';
import type { ParseKeys } from 'i18next';

interface BaseExportPreset {
  id: string;
  /**
   * Translation keys, not strings: the module is evaluated once at import time,
   * while the locale can still change afterwards. The UI resolves them at render
   * (`description` interpolates `{{fps}}`).
   */
  labelKey: ParseKeys;
  descriptionKey: ParseKeys;
  /** Optional quality shown next to the format name in the export sheet. */
  qualityKey?: ParseKeys;
  audioBitrate: number;
}

/** A video export: carries the frame geometry and bitrate the worker needs. */
export interface Mp4Preset extends BaseExportPreset {
  kind: 'mp4';
  /** MP4 presets are tied to a project aspect ratio. */
  aspect: AspectRatio;
  width: number;
  height: number;
  fps: number;
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

export const PRESETS: ExportPreset[] = [
  ...videoPresets('youtube', 'export.preset.youtube.label', '16:9', [
    ['720', 1280, 720, 5_000_000],
    ['1080', 1920, 1080, 12_000_000],
    ['1440', 2560, 1440, 24_000_000],
    ['4k', 3840, 2160, 45_000_000],
  ]),
  ...videoPresets('tiktok', 'export.preset.tiktok.label', '9:16', [
    ['720', 720, 1280, 5_000_000],
    ['1080', 1080, 1920, 12_000_000],
    ['1440', 1440, 2560, 24_000_000],
    ['4k', 2160, 3840, 45_000_000],
  ]),
  ...videoPresets('square', 'export.preset.square.label', '1:1', [
    ['720', 720, 720, 5_000_000],
    ['1080', 1080, 1080, 8_000_000],
    ['1440', 1440, 1440, 16_000_000],
    ['4k', 2160, 2160, 30_000_000],
  ]),
  ...videoPresets('portrait45', 'export.preset.portrait45.label', '4:5', [
    ['720', 576, 720, 5_000_000],
    ['1080', 1080, 1350, 9_000_000],
    ['1440', 1152, 1440, 16_000_000],
    ['4k', 2160, 2700, 30_000_000],
  ]),
  ...audioPresets('mp3', [
    ['128', 128_000],
    ['192', 192_000],
    ['320', 320_000],
  ]),
];

type VideoQuality = readonly [id: '720' | '1080' | '1440' | '4k', width: number, height: number, bitrate: number];
type AudioQuality = readonly [id: '128' | '192' | '320', bitrate: number];

function videoPresets(
  id: string,
  labelKey: ParseKeys,
  aspect: AspectRatio,
  qualities: readonly VideoQuality[],
): Mp4Preset[] {
  return qualities.map(([quality, width, height, videoBitrate]) => ({
    id: `${id}-${quality}`,
    labelKey,
    descriptionKey: 'export.preset.video.description',
    qualityKey: `export.quality.${quality}` as ParseKeys,
    kind: 'mp4',
    aspect,
    width,
    height,
    fps: PROJECT_FPS,
    videoBitrate,
    audioBitrate: 192_000,
  }));
}


function audioPresets(id: string, qualities: readonly AudioQuality[]): Mp3Preset[] {
  return qualities.map(([quality, audioBitrate]) => ({
    id: `${id}-${quality}`,
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

export function exportFileName(preset: ExportPreset): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = preset.kind === 'mp3' ? 'mp3' : 'mp4';
  return `${APP_NAME.toLowerCase()}-${preset.id}-${stamp}.${ext}`;
}
