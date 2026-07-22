import type { FontId } from './lib/fonts';

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5';

export interface Project {
  id: string;
  aspectRatio: AspectRatio;
  fps: number;
  tracks: Track[];
  markers: Marker[];
}

/** A named point on the timeline (cue). */
export interface Marker {
  id: string;
  timeMs: number;
  /** Empty label: the marker shows its number only. */
  label: string;
}

/**
 * Timeline selection - the Vegas "yellow corners". Drives loop playback and
 * can restrict an export to that span. Session state, not project data.
 */
export interface LoopRegion {
  startMs: number;
  endMs: number;
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  clips: Clip[];
  muted?: boolean;
  hidden?: boolean;
  /**
   * Locked tracks still play and export; their clips just cannot be selected,
   * so nothing can move, trim or delete them. Enforced in the selection slice
   * rather than in each operation: every edit acts on the selection, so making
   * a clip unselectable makes it uneditable everywhere at once.
   */
  locked?: boolean;
  /** Track gain applied on top of each clip's volume (0..MAX_GAIN, default 1). */
  volume?: number;
  /** Video only: opacity multiplier for every clip on the track (0..1, default 1). */
  opacity?: number;
}

/**
 * One audio track carried by a source file. A video can multiplex several
 * (VO + dub, commentary, discrete channels); each becomes its own audio clip on
 * import. The `index` is the track's position among ALL audio tracks of the file
 * (as returned by mediabunny's getAudioTracks), so it stays stable across
 * sessions and is what a clip references to pick its source track.
 */
export interface AudioTrackInfo {
  index: number;
  /** ISO 639-2/T language code ('und' if unknown), when the container provides one. */
  language?: string;
  /** Container-provided track name, when present. */
  label?: string;
  /** Channel count of the source track (≥ 1). */
  channels: number;
  /** Normalized peaks (0..1) over the whole duration, for this track's waveform. */
  peaks?: number[];
  /** Container codec string ('eac3', 'ac-3'…), kept to name the codec in the UI. */
  codec?: string;
  /**
   * WebCodecs cannot decode this track in any browser (E-AC-3, AC-3, DTS…). It
   * is listed anyway so the UI can offer to transcode it on demand. This is a
   * property of the file, not a state: it stays true even once transcoded.
   */
  undecodable?: true;
  /**
   * Runtime only: an on-demand transcode has produced a buffer for this
   * undecodable track, so it plays for the rest of the session. Never restored
   * from persistence - the decoded PCM lives in memory only, like every other
   * track's buffer, so a reloaded project must transcode again.
   */
  transcoded?: boolean;
}

/**
 * One subtitle track embedded in a source file (an episode MKV routinely carries
 * several: full, forced, SDH, one per language).
 *
 * Detected by reading the container header, never by decoding: the entry exists
 * so the UI can offer the track, and the cues are only extracted once the user
 * picks one. `index` is the position among the file's SUBTITLE tracks, which is
 * what ffmpeg's `0:s:<n>` selects.
 */
export interface SubtitleTrackInfo {
  index: number;
  /** Language code the container states ('und' filtered out), when it states one. */
  language?: string;
  /** Container-provided track name ("Forced", "SDH"…), when present. */
  label?: string;
  /** Container codec id ('S_TEXT/UTF8', 'tx3g'…), kept to name the format in the UI. */
  codec?: string;
  /**
   * The track holds pictures, not text (PGS and VobSub, i.e. most disc rips).
   * It is listed anyway - the user should learn the subtitles exist and why they
   * cannot come in - but it can never become caption clips without OCR.
   */
  bitmap?: true;
  /** The container marks this track as the one to show by default. */
  default?: true;
  /** The container marks this track as forced (signs and foreign dialogue only). */
  forced?: true;
}

/**
 * Whether a track can actually be heard right now: natively decodable, or an
 * undecodable one the user has already transcoded this session. The mix, the
 * export and the timeline all gate on this so they never disagree.
 */
export function isTrackPlayable(track: AudioTrackInfo): boolean {
  return !track.undecodable || track.transcoded === true;
}

export interface MediaAsset {
  id: string;
  file: File;
  /**
   * 'image' is a still (photo, logo, SVG…): no intrinsic duration, its clips
   * can be stretched freely on the timeline and always show the same frame.
   */
  kind: 'video' | 'audio' | 'image';
  /**
   * For a still image this is only the DEFAULT clip length (a still has no
   * intrinsic duration) - trimming an image clip is never bounded by it.
   */
  durationMs: number;
  width?: number;
  height?: number;
  /**
   * Average source frame rate (video only), measured at import. Drives the
   * adaptive export frame rate so a 30 fps project exports at 30, not an
   * up-sampled 60. Undefined when unknown (audio, or an old persisted asset).
   */
  fps?: number;
  /** Whether the asset has at least one decodable audio track (== audioTracks.length > 0). */
  hasAudio: boolean;
  /**
   * Every decodable audio track of the source, in file order. Empty for a
   * silent video. A pure-audio asset has exactly one entry.
   */
  audioTracks: AudioTrackInfo[];
  /**
   * Subtitle tracks the container carries, in file order. Optional because it is
   * absent from assets persisted before embedded subtitles were supported, and
   * empty for the overwhelming majority of sources.
   */
  subtitleTracks?: SubtitleTrackInfo[];
  /** Thumbnails (data URLs) spread across the duration, used to paint video clips. */
  thumbnails: string[];
  /**
   * Set on restore when the persisted File can no longer be read (the on-disk
   * file was moved, renamed or deleted between sessions). A disconnected asset
   * keeps its metadata and thumbnails so the timeline still renders, but its
   * frames/audio decode to nothing until the user reconnects the source file.
   */
  disconnected?: boolean;
  /**
   * When `file` was produced by remuxing an unreadable container
   * (media/remuxContainer.ts), the identity of the ORIGINAL file the user
   * picked - which is no longer `file`, since that is now the Matroska we wrote.
   * Import dedup matches a re-picked source against this too, so re-importing the
   * same file lands back on this asset instead of remuxing it again into a second
   * card. Absent for the overwhelming majority of assets, whose `file` IS what
   * the user picked.
   */
  originalSource?: { name: string; size: number; lastModified: number };
}

export interface ClipTransform {
  /** Source crop, normalized 0..1 (x, y = top-left corner). */
  crop: { x: number; y: number; w: number; h: number };
  /** Center position of the clip in the output, normalized 0..1 (0.5 = centered). */
  x: number;
  y: number;
  /** Scale multiplier applied after the "contain" fit. */
  scale: number;
  /**
   * Clockwise rotation in degrees around the clip's center. Optional: projects
   * saved before rotation existed have no such field, so every reader must
   * treat `undefined` as 0 rather than assume the key is there.
   */
  rotation?: number;
}

/** Horizontal alignment of a text clip's lines inside its wrap box. */
export type TextAlign = 'left' | 'center' | 'right';

/** Content of a generated text clip (no backing media asset). */
export interface ClipText {
  content: string;
  /** CSS color of the glyphs. */
  color: string;
  /** Font size as a fraction of the output height (0.08 ≈ lower-third title). */
  sizeFrac: number;
  /** Face the glyphs render in. Undefined = the default (see `DEFAULT_FONT_ID`). */
  font?: FontId;
  /** Undefined = centered, the caption default. */
  align?: TextAlign;
  /**
   * Width of the wrap box as a fraction of the output width, centered on
   * `transform.x`: lines longer than this break on word boundaries, and `align`
   * positions them against its edges. Undefined = `DEFAULT_TEXT_WIDTH_FRAC`.
   */
  widthFrac?: number;
  bold?: boolean;
  /** Thick dark stroke behind the glyphs — keeps captions readable over footage. */
  outline?: boolean;
  /** Rounded dark panel behind each line (caption pill). */
  background?: boolean;
}

/** A generated full-frame colour or two-colour gradient. */
export interface ClipSolid {
  /** A single fill, or a linear gradient between the two colours. */
  kind: 'color' | 'gradient';
  color: string;
  color2?: string;
  /** Direction of a gradient, in degrees (0 = left to right). */
  angle?: number;
}

/**
 * A drawn primitive (rectangle, ellipse, N-sided polygon).
 *
 * Only the *size* lives here, as a fraction of the output frame. The centre and
 * the scale come from the clip's `transform`, exactly like a text clip - so
 * dragging a shape in the preview, scaling it with the corner handles and the
 * inspector's Transform section all work with no shape-specific code.
 */
export interface ClipShape {
  kind: 'rect' | 'ellipse' | 'polygon';
  /** Size as a fraction of the output frame, before `transform.scale`. */
  w: number;
  h: number;
  fill: string;
  stroke?: string;
  /** Stroke width as a fraction of the output height; 0 = no stroke. */
  strokeWidth: number;
  /** Corner radius as a fraction of the shorter side, 0..0.5 (rect only). */
  radius: number;
  /** Side count, 3..12 (polygon only). */
  sides: number;
}

/** Fields shared by every clip, whatever it renders. */
interface BaseClip {
  id: string;
  /** Empty string for generated clips (text/solid) that have no media asset. */
  assetId: string;
  trackId: string;
  timelineStartMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  /** 1 = normal, <1 = slow motion, >1 = sped up. */
  speed: number;
  /** Linear gain, 1 = unity. 0 (silence) .. MAX_GAIN (+12 dB). */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Stereo balance, -1 (left) .. 1 (right). Default 0. */
  pan?: number;
  /** Downmix the clip's audio to mono. */
  mono?: boolean;
  /**
   * Link group: every clip sharing one `linkId` moves, trims, splits and
   * deletes together. A group is generic and holds any number of clips on video
   * and audio tracks, with no master side - an import puts the video clip and
   * one clip per extracted audio stream in the same group, and clips can be
   * added to an existing group later. When a group holds at least one clip on
   * an audio track, that clip carries the sound and the video side stays silent
   * in the mix (see `delegatedLinkIds`). Undefined = not linked.
   */
  linkId?: string;
  /**
   * Which audio track of `assetId` this clip plays, as an `AudioTrackInfo.index`.
   * Undefined = the source's primary audio track (the historical single-track
   * behaviour). Set on the audio clips that import splits off a multi-track
   * video so each one carries a different source track.
   */
  audioTrackIndex?: number;
  transform?: ClipTransform;
  /**
   * Animated zoom (Ken Burns): scale multiplier reached at the END of the
   * clip, interpolated linearly from 1 at the start. 1/undefined = static.
   */
  zoomEnd?: number;
}

/** A clip backed by an imported media asset (video or audio). */
export interface MediaClip extends BaseClip {
  kind: 'media';
}

/** A generated clip that renders text instead of media. */
export interface TextClip extends BaseClip {
  kind: 'text';
  text: ClipText;
}

/** A generated clip that renders a full-frame colour or gradient. */
export interface SolidClip extends BaseClip {
  kind: 'solid';
  solid: ClipSolid;
}

/** A generated clip that renders a drawn primitive. */
export interface ShapeClip extends BaseClip {
  kind: 'shape';
  shape: ClipShape;
}

/**
 * Discriminated on `kind`: `text` exists only on a TextClip, `solid` only on a
 * SolidClip and `shape` only on a ShapeClip, so a narrowed clip needs no
 * non-null assertion to read them.
 *
 * The model math (durations, fades, crossfades, output geometry) lives in
 * `src/model/` — this module is types only.
 */
export type Clip = MediaClip | TextClip | SolidClip | ShapeClip;
