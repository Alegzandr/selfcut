import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Clip, Keyframe } from '../types';

/**
 * The `.sfx` document: what survives a round-trip, what extraction deliberately
 * leaves behind, and what a malformed or too-new file must not be allowed to do.
 * The i18n module reaches for the DOM on import, hence the stubs.
 */

vi.mock('../store/store', () => ({ useStore: { getState: () => ({ setError: () => undefined }) } }));

let pf: typeof import('./presetFile');

beforeAll(async () => {
  const g = globalThis as { document?: unknown; window?: unknown };
  g.document ??= { documentElement: {} };
  g.window ??= {};
  pf = await import('./presetFile');
});

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    kind: 'media',
    assetId: 'a1',
    trackId: 'tr-v',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 4000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  } as Clip;
}

function doc(look: unknown, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 'selfcut-preset',
    version: 1,
    app: 'SelfCut 0.1.0',
    createdAt: '2026-07-22T10:00:00.000Z',
    name: 'Warm punch-in',
    sourceDurationMs: 4000,
    look,
    ...over,
  });
}

describe('extractPreset', () => {
  it('round-trips through serialize and parse', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 1 },
      { t: 1500, value: 1.4, ease: 'out' },
      { t: 3000, value: 1.2, bezier: [0.1, 0.2, 0.3, 0.4] },
    ];
    const source = clip({
      color: { saturation: 0.3, temperature: [{ t: 0, value: 0 }, { t: 2000, value: 0.5 }] },
      transform: { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, x: 0.5, y: 0.4, scale: 1.2, rotation: 8 },
      animation: { scale: keys, opacity: [{ t: 0, value: 0 }, { t: 500, value: 1 }] },
      audioFx: [{ type: 'voice', amount: 0.6 }],
      zoomEnd: 1.3,
    });

    const parsed = pf.parsePresetFile(pf.serializePreset(pf.extractPreset(source, 'Warm punch-in', 4000)));

    expect(parsed.name).toBe('Warm punch-in');
    expect(parsed.sourceDurationMs).toBe(4000);
    expect(parsed.look.color).toEqual(source.color);
    expect(parsed.look.animation).toEqual(source.animation);
    expect(parsed.look.audioFx).toEqual(source.audioFx);
    expect(parsed.look.zoomEnd).toBe(1.3);
  });

  it('leaves the crop behind: a preset places the picture, it does not reframe the source', () => {
    const source = clip({
      transform: { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, x: 0.5, y: 0.5, scale: 2 },
    });
    const preset = pf.extractPreset(source, 'p', 4000);
    expect(preset.look.transform).toEqual({ x: 0.5, y: 0.5, scale: 2 });
    expect(preset.look.transform).not.toHaveProperty('crop');
  });

  it('omits identity sections rather than writing defaults', () => {
    const preset = pf.extractPreset(clip({ zoomEnd: 1, color: {}, audioFx: [] }), 'p', 4000);
    expect(preset.look).toEqual({});
  });

  it('omits absent rotation instead of writing 0', () => {
    const source = clip({
      transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.5, scale: 1 },
    });
    expect(pf.extractPreset(source, 'p', 4000).look.transform).not.toHaveProperty('rotation');
  });
});

describe('parsePresetFile envelope', () => {
  it('rejects a project file', () => {
    const text = JSON.stringify({ format: 'selfcut-project', version: 1 });
    expect(() => pf.parsePresetFile(text)).toThrow(pf.PresetFileError);
  });

  it('rejects a version from a newer build', () => {
    expect(() => pf.parsePresetFile(doc({ zoomEnd: 1.2 }, { version: 2 }))).toThrow(
      pf.PresetFileError,
    );
  });

  it('rejects non-JSON', () => {
    expect(() => pf.parsePresetFile('not json at all')).toThrow(pf.PresetFileError);
  });

  it('rejects a look that sanitizes to nothing', () => {
    expect(() => pf.parsePresetFile(doc({ color: { brightness: 'loud' } }))).toThrow(
      pf.PresetFileError,
    );
  });
});

describe('sanitizeLook', () => {
  it('drops an unknown colour key and keeps its siblings', () => {
    const look = pf.sanitizeLook({ color: { brightness: 0.2, sharpen: 0.9 } });
    expect(look.color).toEqual({ brightness: 0.2 });
  });

  it('drops an out-of-order keyframe list and keeps the other properties', () => {
    const look = pf.sanitizeLook({
      animation: {
        scale: [
          { t: 1000, value: 2 },
          { t: 0, value: 1 },
        ],
        opacity: [{ t: 0, value: 1 }],
      },
    });
    expect(look.animation).toEqual({ opacity: [{ t: 0, value: 1 }] });
  });

  it('drops keyframes with a non-finite t or value', () => {
    expect(pf.isValidKeyframes([{ t: NaN, value: 1 }])).toBe(false);
    expect(pf.isValidKeyframes([{ t: 0, value: Infinity }])).toBe(false);
  });

  it('rejects a malformed bezier and an unknown ease', () => {
    expect(pf.isValidKeyframe({ t: 0, value: 1, bezier: [0, 0, 1] })).toBe(false);
    expect(pf.isValidKeyframe({ t: 0, value: 1, ease: 'bounce' })).toBe(false);
    expect(pf.isValidKeyframe({ t: 0, value: 1, ease: 'hold' })).toBe(true);
  });

  it('drops an unknown audio effect, clamps the amount and de-dups by type', () => {
    const look = pf.sanitizeLook({
      audioFx: [
        { type: 'reverb', amount: 5 },
        { type: 'telephone', amount: 0.5 },
        { type: 'reverb', amount: 0.1 },
        { type: 'bass', amount: -2 },
      ],
    });
    expect(look.audioFx).toEqual([
      { type: 'reverb', amount: 1 },
      { type: 'bass', amount: 0 },
    ]);
  });

  it('ignores a crop smuggled into the transform', () => {
    const look = pf.sanitizeLook({
      transform: { x: 0.5, y: 0.5, scale: 1, crop: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } },
    });
    expect(look.transform).toEqual({ x: 0.5, y: 0.5, scale: 1 });
  });

  it('drops a transform missing a required field', () => {
    expect(pf.sanitizeLook({ transform: { x: 0.5, y: 0.5 } }).transform).toBeUndefined();
  });
});

describe('presetFileName', () => {
  it('adds the extension once', () => {
    expect(pf.presetFileName('Warm punch-in')).toBe('Warm punch-in.sfx');
    expect(pf.presetFileName('Warm punch-in.sfx')).toBe('Warm punch-in.sfx');
  });
});
