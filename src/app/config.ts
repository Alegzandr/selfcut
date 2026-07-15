/** Application name - change it in one place. */
export const APP_NAME = 'SelfCut';

/** Application version - keep in sync with package.json. */
export const APP_VERSION = '0.1.0';

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

/** DataTransfer type used to drag an asset from the media library to the timeline. */
export const ASSET_DRAG_MIME = 'application/x-selfcut-asset';

/** Timeline geometry. */
export const TRACK_HEIGHT_PX = 64;
/** Width of the sticky track header (desktop gutter with sliders + meter). */
export const TRACK_HEADER_WIDTH_PX = 112;
/**
 * Desktop timeline pad: t=0 must sit PAST the sticky track header, otherwise
 * the playhead at 0 and the first second of every clip hide under the gutter.
 */
export const TIMELINE_PAD_LEFT = TRACK_HEADER_WIDTH_PX + 8;
/** Marker / loop-region bar, stacked above the ruler (both sticky at the top). */
export const MARKER_BAR_HEIGHT_PX = 18;
export const RULER_HEIGHT_PX = 24;

/** Shortest loop region a drag can create - below that the drag reads as a click (clears it). */
export const MIN_REGION_MS = 40;

