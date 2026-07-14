import { AspectRatio } from '../types';
import { APP_NAME, PROJECT_FPS } from '../app/config';
import type { ParseKeys } from 'i18next';

export interface ExportPreset {
  id: string;
  /**
   * Translation keys, not strings: the module is evaluated once at import time,
   * while the locale can still change afterwards. The UI resolves them at render
   * (`description` interpolates `{{fps}}`).
   */
  labelKey: ParseKeys;
  descriptionKey: ParseKeys;
  kind: 'mp4' | 'mp3';
  /** MP4 presets are tied to a project aspect ratio; MP3 fits any. */
  aspect?: AspectRatio;
  width?: number;
  height?: number;
  fps: number;
  videoBitrate?: number;
  audioBitrate: number;
}

export const PRESETS: ExportPreset[] = [
  {
    id: 'youtube',
    labelKey: 'export.preset.youtube.label',
    descriptionKey: 'export.preset.youtube.description',
    kind: 'mp4',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    fps: PROJECT_FPS,
    videoBitrate: 12_000_000,
    audioBitrate: 192_000,
  },
  {
    id: 'tiktok',
    labelKey: 'export.preset.tiktok.label',
    descriptionKey: 'export.preset.tiktok.description',
    kind: 'mp4',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    fps: PROJECT_FPS,
    videoBitrate: 10_000_000,
    audioBitrate: 192_000,
  },
  {
    id: 'square',
    labelKey: 'export.preset.square.label',
    descriptionKey: 'export.preset.square.description',
    kind: 'mp4',
    aspect: '1:1',
    width: 1080,
    height: 1080,
    fps: PROJECT_FPS,
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
  },
  {
    id: 'portrait45',
    labelKey: 'export.preset.portrait45.label',
    descriptionKey: 'export.preset.portrait45.description',
    kind: 'mp4',
    aspect: '4:5',
    width: 1080,
    height: 1350,
    fps: PROJECT_FPS,
    videoBitrate: 9_000_000,
    audioBitrate: 192_000,
  },
  {
    id: 'mp3',
    labelKey: 'export.preset.mp3.label',
    descriptionKey: 'export.preset.mp3.description',
    kind: 'mp3',
    fps: PROJECT_FPS,
    audioBitrate: 320_000,
  },
];

export function presetsForAspect(aspect: AspectRatio): ExportPreset[] {
  return PRESETS.filter((p) => !p.aspect || p.aspect === aspect);
}

export function exportFileName(preset: ExportPreset): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = preset.kind === 'mp3' ? 'mp3' : 'mp4';
  return `${APP_NAME.toLowerCase()}-${preset.id}-${stamp}.${ext}`;
}
