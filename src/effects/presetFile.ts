import type {
  AudioFx,
  AudioFxType,
  Channel,
  Clip,
  ClipAnimation,
  ClipColor,
  Keyframe,
} from '../types';
import { EASE_IDS } from '../model';
import { AUDIO_FX_TYPES } from './catalog';
import { APP_NAME, APP_VERSION } from '../app/config';
import { t } from '../i18n';

/**
 * The `.sfx` effects preset: one clip's look and motion, lifted off the clip and
 * written to a file so it can land on other footage - the After Effects
 * animation preset, for SelfCut.
 *
 * What travels is exactly what the renderers read: the colour grade, the
 * transform, the keyframed properties and the audio chain. What does not travel
 * is anything that describes a *particular* clip rather than a look: the crop
 * (it frames one source, carrying it elsewhere would reframe shots it knows
 * nothing about), and every timing field.
 *
 * Keyframe times stay absolute. A preset authored over two seconds animates over
 * the first two seconds of whatever it lands on, and keys past the target's end
 * are trimmed - see `presetApply.ts`. Rescaling them to the target's length was
 * the alternative; it makes a punch-in authored as "half a second, then hold"
 * into a lazy drift on a long clip, which is not what the author saw.
 */

const PRESET_FORMAT = 'selfcut-preset';
const PRESET_VERSION = 1;
export const PRESET_FILE_EXT = '.sfx';
export const PRESET_FILE_MIME = 'application/json';

/**
 * The transferable part of a clip's transform: `ClipTransform` minus its crop.
 * A preset says where the picture sits in the frame, never which part of the
 * source is picture.
 */
export interface PresetTransform {
  x: number;
  y: number;
  scale: number;
  rotation?: number;
}

/**
 * The payload. Every field is optional, and absent means "this preset says
 * nothing about that property" - never "reset it". That is what lets a v1 reader
 * take a v2 file safely: it applies the sections it understands and leaves the
 * rest of the target alone, instead of wiping properties it failed to read.
 */
export interface PresetLook {
  /** Colour grade. The fields are `Channel`s, so a keyframed grade travels too. */
  color?: ClipColor;
  /** Static placement, crop excluded. */
  transform?: PresetTransform;
  /** Keyframed transform properties (x/y/scale/rotation/opacity). */
  animation?: ClipAnimation;
  /** The audio chain, in order: the order is the authored intent. */
  audioFx?: AudioFx[];
  /** Ken Burns end scale. Expressed against the clip's own length, so it always fits. */
  zoomEnd?: number;
}

export interface PresetFile {
  format: typeof PRESET_FORMAT;
  version: number;
  /** Informational only - never parsed back, purely to make the file readable. */
  app: string;
  createdAt: string;
  /** User-visible name: the shelf label and the suggested filename. */
  name: string;
  /**
   * Clip-local duration (ms) of the clip this was captured from. It never
   * retimes anything - times are absolute. It exists so the editor can *report*
   * that a preset outran the clip it landed on rather than trimming in silence.
   */
  sourceDurationMs: number;
  look: PresetLook;
}

/** The colour parameters, as a runtime allowlist for extraction and parsing. */
const COLOR_PROPS = [
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'vignette',
  'blur',
] as const satisfies readonly (keyof ClipColor)[];

/** The keyframable transform properties, likewise. */
const ANIMATION_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

const EASE_SET = new Set<string>(EASE_IDS);
const AUDIO_FX_SET = new Set<string>(AUDIO_FX_TYPES);

function isFinite_(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function copyChannel(ch: Channel): Channel {
  return Array.isArray(ch) ? ch.map((k) => ({ ...k })) : ch;
}

/**
 * Capture a clip's look and motion. Anything at its identity is left out rather
 * than written as a default: a preset that only grades should not also pin the
 * target's placement to wherever the source clip happened to sit.
 */
export function extractPreset(clip: Clip, name: string, sourceDurationMs: number): PresetFile {
  const look: PresetLook = {};

  if (clip.color) {
    const color: ClipColor = {};
    // Copied key by key off a fixed list rather than spread, so no field the
    // runtime happens to be carrying can leak into a file we promise to read.
    for (const key of COLOR_PROPS) {
      const ch = clip.color[key];
      if (ch !== undefined) color[key] = copyChannel(ch);
    }
    if (Object.keys(color).length) look.color = color;
  }

  if (clip.transform) {
    const { x, y, scale, rotation } = clip.transform;
    look.transform = { x, y, scale, ...(rotation !== undefined ? { rotation } : {}) };
  }

  if (clip.animation) {
    const animation: ClipAnimation = {};
    for (const prop of ANIMATION_PROPS) {
      const keys = clip.animation[prop];
      if (keys?.length) animation[prop] = keys.map((k) => ({ ...k }));
    }
    if (Object.keys(animation).length) look.animation = animation;
  }

  if (clip.audioFx?.length) look.audioFx = clip.audioFx.map((fx) => ({ ...fx }));
  if (clip.zoomEnd !== undefined && clip.zoomEnd !== 1) look.zoomEnd = clip.zoomEnd;

  return {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    app: `${APP_NAME} ${APP_VERSION}`,
    createdAt: new Date().toISOString(),
    name,
    sourceDurationMs,
    look,
  };
}

export function serializePreset(doc: PresetFile): string {
  return JSON.stringify(doc);
}

/** Whether a look would change anything at all. An empty one is a broken file. */
export function isEmptyLook(look: PresetLook): boolean {
  return Object.keys(look).length === 0;
}

/** Thrown with an already-translated message when a file is not a usable preset. */
export class PresetFileError extends Error {}

export function isValidKeyframe(v: unknown): v is Keyframe {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Keyframe;
  if (!isFinite_(k.t) || !isFinite_(k.value)) return false;
  if (k.ease !== undefined && !EASE_SET.has(k.ease)) return false;
  if (k.bezier !== undefined) {
    if (!Array.isArray(k.bezier) || k.bezier.length !== 4) return false;
    if (!k.bezier.every(isFinite_)) return false;
  }
  return true;
}

/**
 * A keyframe list, which must be non-empty and sorted by `t`.
 *
 * Deliberately not sorted-on-read: every reader in the app (`sampleChannel`, the
 * lane renderer, the selection bounds) assumes sorted order, so quietly fixing a
 * file that broke it would hide the defect and make the next bug much harder to
 * find. A property whose keys arrive out of order is dropped instead.
 */
export function isValidKeyframes(v: unknown): v is Keyframe[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  for (let i = 0; i < v.length; i++) {
    if (!isValidKeyframe(v[i])) return false;
    if (i > 0 && (v[i] as Keyframe).t < (v[i - 1] as Keyframe).t) return false;
  }
  return true;
}

export function isValidChannel(v: unknown): v is Channel {
  return isFinite_(v) || isValidKeyframes(v);
}

function sanitizeAudioFx(v: unknown): AudioFx[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const chain: AudioFx[] = [];
  const seen = new Set<AudioFxType>();
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const fx = raw as AudioFx;
    if (!AUDIO_FX_SET.has(fx.type) || !isFinite_(fx.amount)) continue;
    // One node per type: two of the same in the chain would run twice in the
    // graph while the inspector showed one row, the case `catalog.ts` guards.
    if (seen.has(fx.type)) continue;
    seen.add(fx.type);
    chain.push({ type: fx.type, amount: Math.max(0, Math.min(1, fx.amount)) });
  }
  return chain.length ? chain : undefined;
}

/**
 * Filter an untrusted look down to what we can actually apply, walking a fixed
 * allowlist rather than the input's own keys.
 *
 * Lenient by design, unlike the envelope checks: a malformed property is dropped
 * and its siblings still land. A file can be hand-edited or written by a later
 * build, and applying six of a preset's seven parameters beats refusing all
 * seven over one bad number.
 */
export function sanitizeLook(v: unknown): PresetLook {
  if (typeof v !== 'object' || v === null) return {};
  const raw = v as PresetLook;
  const look: PresetLook = {};

  if (typeof raw.color === 'object' && raw.color !== null) {
    const color: ClipColor = {};
    for (const key of COLOR_PROPS) {
      const ch = raw.color[key];
      if (isValidChannel(ch)) color[key] = copyChannel(ch);
    }
    if (Object.keys(color).length) look.color = color;
  }

  if (typeof raw.transform === 'object' && raw.transform !== null) {
    const { x, y, scale, rotation } = raw.transform;
    if (isFinite_(x) && isFinite_(y) && isFinite_(scale)) {
      look.transform = { x, y, scale, ...(isFinite_(rotation) ? { rotation } : {}) };
    }
  }

  if (typeof raw.animation === 'object' && raw.animation !== null) {
    const animation: ClipAnimation = {};
    for (const prop of ANIMATION_PROPS) {
      const keys = raw.animation[prop];
      if (isValidKeyframes(keys)) animation[prop] = keys.map((k) => ({ ...k }));
    }
    if (Object.keys(animation).length) look.animation = animation;
  }

  const audioFx = sanitizeAudioFx(raw.audioFx);
  if (audioFx) look.audioFx = audioFx;
  if (isFinite_(raw.zoomEnd) && raw.zoomEnd > 0) look.zoomEnd = raw.zoomEnd;

  return look;
}

/**
 * Parse a `.sfx` document. Rejects anything that is not this format, and a
 * version from a newer build - same reasoning as the project file: applying a
 * preset we only half understand would silently drop what it holds that we
 * cannot read, and the user would blame the look, not the reader.
 */
export function parsePresetFile(text: string): PresetFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PresetFileError(t('errors.preset.invalidFile'));
  }
  const file = doc as PresetFile;
  if (typeof doc !== 'object' || doc === null || file.format !== PRESET_FORMAT) {
    throw new PresetFileError(t('errors.preset.invalidFile'));
  }
  if (typeof file.version !== 'number' || file.version > PRESET_VERSION) {
    throw new PresetFileError(t('errors.preset.futureVersion'));
  }
  const look = sanitizeLook(file.look);
  // Nothing survived the filter: the file parses as JSON but says nothing we can
  // apply, which is a broken preset rather than a preset that does nothing.
  if (isEmptyLook(look)) throw new PresetFileError(t('errors.preset.invalidFile'));

  return {
    format: PRESET_FORMAT,
    version: file.version,
    app: typeof file.app === 'string' ? file.app : '',
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
    name: typeof file.name === 'string' && file.name.trim() ? file.name : t('preset.untitled'),
    sourceDurationMs: isFinite_(file.sourceDurationMs) ? file.sourceDurationMs : 0,
    look,
  };
}

/** Filename for a preset, with the extension added unless the name already has it. */
export function presetFileName(name: string): string {
  const base = name.trim() || t('preset.untitled');
  return base.toLowerCase().endsWith(PRESET_FILE_EXT) ? base : `${base}${PRESET_FILE_EXT}`;
}
