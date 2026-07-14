import { describe, it, expect } from 'vitest';
import { PRESETS, presetsForAspect, exportFileName } from './presets';

describe('presetsForAspect', () => {
  it('returns the matching video presets plus the aspect-agnostic audio ones', () => {
    const got = presetsForAspect('16:9');
    // every returned preset is either 16:9 or aspect-agnostic (mp3)
    expect(got.every((p) => p.kind === 'mp3' || p.aspect === '16:9')).toBe(true);
    // no preset tied to a different aspect leaks through
    expect(got.some((p) => p.kind === 'mp4' && p.aspect === '9:16')).toBe(false);
    // the mp3 presets are always available
    expect(got.some((p) => p.kind === 'mp3')).toBe(true);
  });

  it('gives each aspect the same audio presets', () => {
    const audio = (aspect: '16:9' | '9:16') => presetsForAspect(aspect).filter((p) => p.kind === 'mp3').map((p) => p.id);
    expect(audio('16:9')).toEqual(audio('9:16'));
  });

  it('all presets carry translation keys and a kind', () => {
    for (const p of PRESETS) {
      expect(p.labelKey).toBeTruthy();
      expect(p.descriptionKey).toBeTruthy();
      expect(p.kind === 'mp4' || p.kind === 'mp3').toBe(true);
    }
  });
});

describe('exportFileName', () => {
  it('uses the mp4 extension and embeds the preset id for video', () => {
    const preset = PRESETS.find((p) => p.kind === 'mp4')!;
    const name = exportFileName(preset);
    expect(name.endsWith('.mp4')).toBe(true);
    expect(name).toContain(preset.id);
  });
  it('uses the mp3 extension for audio', () => {
    const preset = PRESETS.find((p) => p.kind === 'mp3')!;
    expect(exportFileName(preset).endsWith('.mp3')).toBe(true);
  });
});
