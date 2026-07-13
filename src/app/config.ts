/** Application name — change it in one place. */
export const APP_NAME = 'Cutbay';

/** Fixed frame rate for the project and export. */
export const PROJECT_FPS = 60 as const;

/** Minimum clip duration on the timeline (ms). */
export const MIN_CLIP_DURATION_MS = 100;

/** Snapping threshold in screen pixels. */
export const SNAP_THRESHOLD_PX = 8;

/** Timeline zoom bounds (pixels per second). */
export const MIN_PX_PER_SEC = 4;
export const MAX_PX_PER_SEC = 600;
export const DEFAULT_PX_PER_SEC = 60;

/** Sample rate of the audio mix (preview + export). */
export const AUDIO_SAMPLE_RATE = 48000;

/** Timeline geometry. */
export const TRACK_HEIGHT_PX = 64;
export const TIMELINE_PAD_LEFT = 48;

