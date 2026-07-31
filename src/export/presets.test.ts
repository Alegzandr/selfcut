import { describe, it, expect } from 'vitest';
import {
  PRESETS,
  presetsForAspect,
  presetSectionsForAspect,
  exportFileName,
  normalizeExportFps,
  videoBitrateForFps,
  projectExportFps,
  resolveMp4Preset,
} from './presets';
import type { Mp4Preset } from './presets';
import type { AspectRatio, Clip, MediaAsset, Project } from '../types';

const ASPECTS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:5'];

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

  it('gives every preset a unique id (the id names the exported file)', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers the same custom presets for every aspect ratio', () => {
    const customLabels = (aspect: AspectRatio) =>
      presetsForAspect(aspect)
        .filter((p) => p.group === 'custom')
        .map((p) => p.labelKey);
    expect(customLabels('16:9').length).toBeGreaterThan(0);
    for (const aspect of ASPECTS) expect(customLabels(aspect)).toEqual(customLabels('16:9'));
  });

  it('every custom preset says what it is for; the social ones need no hint', () => {
    for (const p of PRESETS) {
      if (p.group === 'custom') expect(p.hintKey).toBeTruthy();
      else expect(p.hintKey).toBeUndefined();
    }
  });
});

describe('presetSectionsForAspect', () => {
  it('lists social, then custom, then audio, with no empty section', () => {
    const sections = presetSectionsForAspect('9:16');
    expect(sections.map((s) => s.group)).toEqual(['social', 'custom', 'audio']);
    for (const section of sections) {
      expect(section.titleKey).toBeTruthy();
      expect(section.presets.length).toBeGreaterThan(0);
    }
  });

  it('flattens back to the flat order, so the default pick is the first row shown', () => {
    for (const aspect of ASPECTS) {
      const flat = presetSectionsForAspect(aspect).flatMap((s) => s.presets);
      expect(flat).toEqual(presetsForAspect(aspect));
    }
  });
});

describe('bitrates meet the platforms’ upload recommendations', () => {
  const mp4 = (id: string): Mp4Preset => {
    const preset = PRESETS.find((p) => p.id === id);
    expect(preset, `missing preset ${id}`).toBeDefined();
    expect(preset!.kind).toBe('mp4');
    return preset as Mp4Preset;
  };

  // The project exports at 60 fps, so YouTube's 48-60 fps SDR figures are the
  // reference floor (720p 7.5, 1080p 12, 1440p 24, 4K 53-68 Mbps).
  it.each([
    ['youtube-720', 7_500_000],
    ['youtube-1080', 12_000_000],
    ['youtube-1440', 24_000_000],
    ['youtube-4k', 53_000_000],
  ])('%s meets the YouTube 60fps SDR floor', (id, floor) => {
    expect(mp4(id).videoBitrate).toBeGreaterThanOrEqual(floor);
  });

  it('every video preset ships 384 kbps AAC (YouTube AAC-LC recommendation)', () => {
    for (const p of PRESETS) {
      if (p.kind === 'mp4') expect(p.audioBitrate).toBeGreaterThanOrEqual(384_000);
    }
  });

  // The custom presets only earn their place by sitting outside what a platform
  // upload asks for - above it for a master, below it for a file to email.
  it('4K Ultra outruns the platform 4K figure', () => {
    expect(mp4('ultra4k-16x9').videoBitrate).toBeGreaterThan(mp4('youtube-4k').videoBitrate);
  });

  it('the 1080p master outruns the platform 1080p figure', () => {
    expect(mp4('master1080-16x9').videoBitrate).toBeGreaterThan(mp4('youtube-1080').videoBitrate);
  });

  it('the light 1080p preset undercuts it, at the same geometry', () => {
    const light = mp4('light1080-16x9');
    const upload = mp4('youtube-1080');
    expect(light.videoBitrate).toBeLessThan(upload.videoBitrate);
    expect([light.width, light.height]).toEqual([upload.width, upload.height]);
  });
});

describe('adaptive export frame rate', () => {
  it('snaps NTSC and out-of-range source rates to the export ladder', () => {
    expect(normalizeExportFps(23.976)).toBe(24);
    expect(normalizeExportFps(29.97)).toBe(30);
    expect(normalizeExportFps(59.94)).toBe(60);
    expect(normalizeExportFps(25)).toBe(25);
    // Above the ladder (e.g. 120 fps action-cam) is capped at the project rate.
    expect(normalizeExportFps(120)).toBe(60);
    // Unknown / degenerate rates fall back to the project rate.
    expect(normalizeExportFps(0)).toBe(60);
    expect(normalizeExportFps(NaN)).toBe(60);
  });

  it('charges the full high-frame-rate bitrate only at/above 48 fps', () => {
    const yt = PRESETS.find((preset) => preset.id === 'youtube-1080') as Mp4Preset;
    expect(videoBitrateForFps(yt, 60)).toBe(yt.videoBitrate);
    expect(videoBitrateForFps(yt, 50)).toBe(yt.videoBitrate);
    // Standard frame rate gets ~2/3 (YouTube's own 1080p split: 8 vs 12 Mbps).
    expect(videoBitrateForFps(yt, 30)).toBe(Math.round((yt.videoBitrate * 2) / 3));
    expect(videoBitrateForFps(yt, 24)).toBeLessThan(yt.videoBitrate);
  });

  const mediaClip = (assetId: string): Clip =>
    ({ id: `clip-${assetId}`, kind: 'media', assetId } as Clip);

  const projectOf = (...clips: Clip[]): Project =>
    ({
      id: 'p',
      aspectRatio: '16:9',
      fps: 60,
      markers: [],
      tracks: [{ id: 'v', kind: 'video', clips }],
    } as Project);

  const asset = (id: string, fps?: number): MediaAsset =>
    ({ id, kind: 'video', fps } as MediaAsset);

  it('exports at the fastest source rate on the timeline', () => {
    const project = projectOf(mediaClip('a'), mediaClip('b'));
    const assets = { a: asset('a', 30), b: asset('b', 60) };
    expect(projectExportFps(project, assets)).toBe(60);
  });

  it('keeps an all-30fps project at 30, not an up-sampled 60', () => {
    const project = projectOf(mediaClip('a'), mediaClip('b'));
    const assets = { a: asset('a', 29.97), b: asset('b', 30) };
    expect(projectExportFps(project, assets)).toBe(30);
  });

  it('falls back to the project rate when no source rate is known', () => {
    const project = projectOf(mediaClip('a'));
    expect(projectExportFps(project, { a: asset('a', undefined) })).toBe(60);
    expect(projectExportFps(project, {})).toBe(60);
  });

  const mp4 = (id: string) => PRESETS.find((p) => p.id === id) as Mp4Preset;

  it('a source-rate preset follows the footage', () => {
    const light = mp4('light1080-16x9');
    expect(light.fpsMode).toBe('source');
    const resolved = resolveMp4Preset(light, projectOf(mediaClip('a')), { a: asset('a', 25) });
    expect(resolved.fps).toBe(25);
  });

  it('a fixed-rate preset keeps its own rate whatever the footage', () => {
    const project = projectOf(mediaClip('a'));
    const assets = { a: asset('a', 30) };

    const smooth = mp4('smooth120-16x9');
    expect(smooth.fpsMode).toBe('fixed');
    // Above the ladder on purpose: 120 fps is what the user picked the preset for.
    expect(resolveMp4Preset(smooth, project, assets).fps).toBe(120);

    const cinema = mp4('cinema24-16x9');
    const resolved = resolveMp4Preset(cinema, project, assets);
    expect(resolved.fps).toBe(24);
    // videoBitrate keeps one meaning everywhere: the HFR figure, scaled down at
    // standard rates - a pinned rate is no exception.
    expect(resolved.videoBitrate).toBe(Math.round((cinema.videoBitrate * 2) / 3));
  });

  it('the masters export at 60 fps even from slower footage', () => {
    const project = projectOf(mediaClip('a'));
    const assets = { a: asset('a', 24) };
    for (const id of ['ultra4k-16x9', 'master1080-16x9']) {
      const master = mp4(id);
      expect(master.fpsMode).toBe('fixed');
      const resolved = resolveMp4Preset(master, project, assets);
      expect(resolved.fps).toBe(60);
      // 60 fps is high-frame-rate, so a master always carries its full bitrate.
      expect(resolved.videoBitrate).toBe(master.videoBitrate);
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
