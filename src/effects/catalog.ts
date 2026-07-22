import type { ParseKeys } from 'i18next';
import type { AudioFxType, Clip, ClipColor, MediaAsset, TransitionType } from '../types';
import { DEFAULT_TRANSFORM } from '../model';

/**
 * The browsable effect catalogue behind the library's Effects tab.
 *
 * Effects are not a runtime registry: a clip stores its look in flat fields
 * (`color`, `audioFx`, `transform`, `zoomEnd`), and the renderers read those
 * directly. This module is the missing *index* over them - a named, draggable
 * entry that knows which clips it applies to and what patch it lays down. It
 * adds no new state and no new rendering path: every preset here resolves to
 * fields the inspector already edits and the compositor already draws.
 */

export type EffectGroup = 'video' | 'audio';

export interface EffectPreset {
  /** Stable id: the drag payload and the React key. */
  id: string;
  group: EffectGroup;
  /**
   * Points at the key the inspector already uses for this effect rather than a
   * parallel `effects.*` namespace: the catalogue and the inspector then name
   * the same thing with the same word in every locale, by construction.
   */
  labelKey: ParseKeys;
  /**
   * Whether the preset means anything for this clip. A colour grade on an audio
   * clip and a reverb on a silent still are both no-ops, and a catalogue that
   * lets you drop them anyway teaches that effects sometimes do nothing.
   */
  accepts: (clip: Clip, asset: MediaAsset | undefined) => boolean;
  /**
   * The patch to merge into the clip. Takes the clip so a preset can build on
   * what is already there instead of flattening it (the looks keep an existing
   * blur, the audio presets append to the chain).
   */
  patch: (clip: Clip) => Partial<Clip>;
}

/**
 * Every audio effect type, in chain order. Exported so the preset parser can
 * check an imported chain against the same list the catalogue is built from.
 */
export const AUDIO_FX_TYPES: AudioFxType[] = ['leveler', 'voice', 'bass', 'reverb', 'echo'];

/** A clip that paints picture: the only kind a colour grade or a zoom can touch. */
function paintsPicture(_clip: Clip, asset: MediaAsset | undefined): boolean {
  return !!asset && asset.kind !== 'audio';
}

/** A clip that carries sound. Mirrors the inspector's `hasAudio` gate. */
function carriesAudio(_clip: Clip, asset: MediaAsset | undefined): boolean {
  return asset?.hasAudio ?? false;
}

/** Intensity a freshly applied audio effect starts at (matches the inspector). */
const DEFAULT_FX_AMOUNT = 0.5;

/**
 * One-tap looks. Identical grades to the inspector's filter row, so applying
 * "Vintage" from the library and from the inspector land on the same values.
 * Blur is carried over rather than reset: it reads as focus, not as a look.
 */
const LOOKS: { id: string; color: ClipColor }[] = [
  { id: 'bw', color: { saturation: -1 } },
  { id: 'warm', color: { temperature: 0.4, saturation: 0.1 } },
  { id: 'cool', color: { temperature: -0.4 } },
  { id: 'vintage', color: { temperature: 0.25, contrast: -0.15, saturation: -0.2, vignette: 0.4 } },
  { id: 'vivid', color: { saturation: 0.4, contrast: 0.15 } },
];

/** Grades that layer onto the current colour instead of replacing it. */
const GRADES: { id: string; color: ClipColor }[] = [
  { id: 'blur', color: { blur: 0.3 } },
  { id: 'vignette', color: { vignette: 0.5 } },
];

export const EFFECTS: EffectPreset[] = [
  ...LOOKS.map(
    (look): EffectPreset => ({
      id: look.id,
      group: 'video',
      labelKey: `inspector.filters.${look.id}` as ParseKeys,
      accepts: paintsPicture,
      patch: (clip) => ({ color: { ...look.color, blur: clip.color?.blur } }),
    }),
  ),
  ...GRADES.map(
    (grade): EffectPreset => ({
      id: grade.id,
      group: 'video',
      labelKey: `inspector.adjust.${grade.id}` as ParseKeys,
      accepts: paintsPicture,
      patch: (clip) => ({ color: { ...clip.color, ...grade.color } }),
    }),
  ),
  {
    // The same push-in the P shortcut applies, reachable by drag.
    id: 'punchIn',
    group: 'video',
    labelKey: 'menu.clip.punchIn',
    accepts: paintsPicture,
    patch: (clip) => ({
      transform: { ...(clip.transform ?? DEFAULT_TRANSFORM), scale: 1.2 },
    }),
  },
  {
    // Ken Burns: a slow drift in across the clip's own length.
    id: 'kenBurns',
    group: 'video',
    labelKey: 'inspector.zoomAnim',
    accepts: paintsPicture,
    patch: () => ({ zoomEnd: 1.2 }),
  },
  ...AUDIO_FX_TYPES.map(
    (type): EffectPreset => ({
      id: type,
      group: 'audio',
      labelKey: `inspector.audioFx.${type}` as ParseKeys,
      accepts: carriesAudio,
      patch: (clip) => {
        const chain = clip.audioFx ?? [];
        // Re-applying an effect already in the chain must not stack a second
        // copy of it - the inspector's toggle row would then show one entry
        // while the graph ran two.
        if (chain.some((fx) => fx.type === type)) return {};
        return { audioFx: [...chain, { type, amount: DEFAULT_FX_AMOUNT }] };
      },
    }),
  ),
];

export const EFFECTS_BY_ID: Record<string, EffectPreset> = Object.fromEntries(
  EFFECTS.map((fx) => [fx.id, fx]),
);

/**
 * Transition styles, in catalogue order. Shared with the inspector's picker so
 * the two surfaces can never drift apart.
 */
export const TRANSITIONS: TransitionType[] = [
  'dissolve',
  'dipBlack',
  'dipWhite',
  'slideLeft',
  'slideRight',
  'slideUp',
  'slideDown',
  'wipe',
  'zoom',
];

const TRANSITION_SET = new Set<string>(TRANSITIONS);

export function isTransitionType(value: string): value is TransitionType {
  return TRANSITION_SET.has(value);
}
