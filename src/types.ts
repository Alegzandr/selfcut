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
  /** Track gain applied on top of each clip's volume (0..MAX_GAIN, default 1). */
  volume?: number;
  /** Video only: opacity multiplier for every clip on the track (0..1, default 1). */
  opacity?: number;
}

/**
 * One decodable audio track carried by a source file. A video can multiplex
 * several (VO + dub, commentary, discrete channels); each becomes its own audio
 * clip on import. The `index` is the track's position among ALL audio tracks of
 * the file (as returned by mediabunny's getAudioTracks), so it stays stable
 * across sessions and is what a clip references to pick its source track.
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
  /** Thumbnails (data URLs) spread across the duration, used to paint video clips. */
  thumbnails: string[];
  /**
   * Set on restore when the persisted File can no longer be read (the on-disk
   * file was moved, renamed or deleted between sessions). A disconnected asset
   * keeps its metadata and thumbnails so the timeline still renders, but its
   * frames/audio decode to nothing until the user reconnects the source file.
   */
  disconnected?: boolean;
}

export interface ClipTransform {
  /** Source crop, normalized 0..1 (x, y = top-left corner). */
  crop: { x: number; y: number; w: number; h: number };
  /** Center position of the clip in the output, normalized 0..1 (0.5 = centered). */
  x: number;
  y: number;
  /** Scale multiplier applied after the "contain" fit. */
  scale: number;
}

/** Content of a generated text clip (no backing media asset). */
export interface ClipText {
  content: string;
  /** CSS color of the glyphs. */
  color: string;
  /** Font size as a fraction of the output height (0.08 ≈ lower-third title). */
  sizeFrac: number;
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
   * A/V link: a video clip and the audio clip extracted from the same source on
   * import share one `linkId`. Linked clips move, trim, split and delete
   * together. The audio lives on the audio clip, so the video side of a link
   * delegates its audio (it stays silent in the mix). Undefined = not linked.
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

/**
 * Discriminated on `kind`: `text` exists only on a TextClip and `solid` only on
 * a SolidClip, so a narrowed clip needs no non-null assertion to read them.
 *
 * The model math (durations, fades, crossfades, output geometry) lives in
 * `src/model/` — this module is types only.
 */
export type Clip = MediaClip | TextClip | SolidClip;
