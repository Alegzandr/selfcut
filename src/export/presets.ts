import { AspectRatio } from '../types';
import { APP_NAME, PROJECT_FPS } from '../app/config';

export interface ExportPreset {
  id: string;
  label: string;
  description: string;
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
    label: 'YouTube 16:9',
    description: `1920×1080 @ ${PROJECT_FPS} fps · H.264 ~12 Mbps · AAC 192 kbps`,
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
    label: 'TikTok 9:16',
    description: `1080×1920 @ ${PROJECT_FPS} fps · H.264 ~10 Mbps · AAC 192 kbps`,
    kind: 'mp4',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    fps: PROJECT_FPS,
    videoBitrate: 10_000_000,
    audioBitrate: 192_000,
  },
  {
    id: 'mp3',
    label: 'MP3 (audio only)',
    description: 'Full mix · 320 kbps',
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
