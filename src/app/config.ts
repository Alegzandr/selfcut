/** Application name - change it in one place. */
export const APP_NAME = 'SelfCut';

/** Application version - keep in sync with package.json. */
export const APP_VERSION = '0.1.0';

/** Fixed frame rate for the project and export. */
export const PROJECT_FPS = 60 as const;

/** Minimum clip duration on the timeline (ms). */
export const MIN_CLIP_DURATION_MS = 100;

/** Default timeline duration of a still-image clip (a still has no intrinsic length). */
export const IMAGE_CLIP_DEFAULT_MS = 5000;

/** Snapping threshold in screen pixels. */
export const SNAP_THRESHOLD_PX = 8;

/**
 * Preview magnetism, expressed in SCREEN pixels like the timeline's - so the
 * pull feels the same however far the preview camera is zoomed in. A threshold
 * kept in normalized stage units would silently grow with the zoom.
 */
export const PREVIEW_SNAP_THRESHOLD_PX = 9;

/**
 * Angles a rotation gesture snaps to (degrees). 15° steps give the useful
 * detents - the uprights, the diagonals, and the slight-tilt look - without the
 * grid getting so dense that free angles become unreachable.
 */
export const ROTATION_SNAP_STEP_DEG = 15;

/** Half-width of the pull around each rotation detent, in degrees. */
export const ROTATION_SNAP_THRESHOLD_DEG = 4;

/** Timeline zoom bounds (pixels per second). */
export const MIN_PX_PER_SEC = 0.9;
export const MAX_PX_PER_SEC = 600;
export const DEFAULT_PX_PER_SEC = 60;

/** Sample rate of the audio mix (preview + export). */
export const AUDIO_SAMPLE_RATE = 48000;

/**
 * Preview playback resolution, à la the "playback/timeline resolution" control
 * in Vegas / Premiere. Each rung composites the monitor at a fraction of the
 * export size (cheaper); when a rung still can't keep up the engine drops
 * frames with audio as the clock, so the picture never changes sharpness
 * mid-playback. A manual pick - no mid-playback resolution pumping.
 */
export type PreviewResolutionMode = 'full' | 'half' | 'quarter' | 'eighth';

/** Render scale (fraction of the full output size) for each rung. */
export const PREVIEW_RESOLUTION_SCALE: Record<PreviewResolutionMode, number> = {
  full: 1,
  half: 1 / 2,
  quarter: 1 / 4,
  eighth: 1 / 8,
};

/** Default preview resolution: half the export size (sharp on screen, cheap). */
export const DEFAULT_PREVIEW_RESOLUTION: PreviewResolutionMode = 'half';

/** DataTransfer type used to drag an asset from the media library to the timeline. */
export const ASSET_DRAG_MIME = 'application/x-selfcut-asset';

/** Timeline geometry. */
export const TRACK_HEIGHT_PX = 64;
/**
 * Vertical zoom bounds for the track lanes. One height for every track rather
 * than a per-track one: the timeline converts a pointer's Y straight into a row
 * index (`floor(y / height)`), which stays exact only while the rows are
 * uniform. MIN still clears the waveform; MAX keeps a filmstrip legible.
 */
export const MIN_TRACK_HEIGHT_PX = 36;
export const MAX_TRACK_HEIGHT_PX = 160;
/** Width of the fixed track-header pane (desktop: sliders + meter; coarse: buttons only). */
export const TRACK_HEADER_WIDTH_PX = 168;
export const TRACK_HEADER_WIDTH_COARSE_PX = 44;
/**
 * Resize bounds for the header pane. MIN still fits the button column plus a
 * usable fader; MAX stops it from eating the timeline on a narrow window.
 */
export const MIN_TRACK_HEADER_WIDTH_PX = 96;
export const MAX_TRACK_HEADER_WIDTH_PX = 360;

/** Docked side panels (desktop): default width and resize bounds. */
export const LIBRARY_WIDTH_PX = 224;
export const MIN_LIBRARY_WIDTH_PX = 160;
export const MAX_LIBRARY_WIDTH_PX = 520;
export const INSPECTOR_WIDTH_PX = 288;
export const MIN_INSPECTOR_WIDTH_PX = 220;
export const MAX_INSPECTOR_WIDTH_PX = 560;
/**
 * Desktop timeline pad. The header pane sits outside the scroller, so t=0 is
 * flush with the scroller's left edge - like every NLE.
 */
export const TIMELINE_PAD_LEFT = 0;
/** Marker / loop-region bar, stacked above the ruler (both sticky at the top). */
export const MARKER_BAR_HEIGHT_PX = 18;
export const RULER_HEIGHT_PX = 24;

/** Shortest loop region a drag can create - below that the drag reads as a click (clears it). */
export const MIN_REGION_MS = 40;

