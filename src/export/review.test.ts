import { describe, it, expect } from 'vitest';
import type { Clip, MediaAsset, Project, Track } from '../types';
import { blackGaps, reviewProject, textClearance, type ReviewInput } from './review';

function clip(id: string, startMs: number, durMs: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'media',
    id,
    assetId: 'cam',
    trackId: 't',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: durMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...extra,
  } as Clip;
}

function title(id: string, startMs: number, durMs: number, y: number, extra: Partial<Clip> = {}): Clip {
  return {
    ...clip(id, startMs, durMs),
    kind: 'text',
    assetId: '',
    transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
    text: { content: id, color: '#fff', sizeFrac: 0.05 },
    ...extra,
  } as Clip;
}

function lane(id: string, clips: Clip[], kind: Track['kind'] = 'video', extra: Partial<Track> = {}): Track {
  return { id, kind, clips: clips.map((c) => ({ ...c, trackId: id })), ...extra };
}

function project(tracks: Track[], aspectRatio: Project['aspectRatio'] = '9:16'): Project {
  return { id: 'p', aspectRatio, fps: 60, tracks, markers: [] };
}

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  file: new File([], `${id}.mp4`),
  kind: 'video',
  durationMs: 60_000,
  width: 1080,
  height: 1920,
  hasAudio: true,
  audioTracks: [],
  thumbnails: [],
  ...extra,
});

const ASSETS = { cam: asset('cam'), wide: asset('wide', { width: 1920, height: 1080 }) };

const review = (p: Project, over: Partial<ReviewInput> = {}) =>
  reviewProject({ project: p, assets: ASSETS, region: null, target: 'social', normalize: true, ...over });

const ids = (p: Project, over: Partial<ReviewInput> = {}) => review(p, over).map((i) => i.id);

describe('blackGaps', () => {
  it('finds the holes between, before and after the pictures', () => {
    const p = project([lane('v', [clip('a', 500, 1000), clip('b', 2000, 1000)]), lane('a', [clip('m', 0, 4000)], 'audio')]);
    expect(blackGaps(p, 0, 4000)).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 1500, endMs: 2000 },
      { startMs: 3000, endMs: 4000 },
    ]);
  });

  it('counts any lane as cover, and ignores a hidden one', () => {
    const p = project([lane('top', [clip('a', 0, 1000)]), lane('hidden', [clip('b', 1000, 1000)], 'video', { hidden: true })]);
    expect(blackGaps(p, 0, 2000)).toEqual([{ startMs: 1000, endMs: 2000 }]);
  });

  it('has nothing to say about a sound-only piece', () => {
    expect(blackGaps(project([lane('a', [clip('m', 0, 4000)], 'audio')]), 0, 4000)).toEqual([]);
  });
});

describe('textClearance', () => {
  it('lifts a vertical caption out of the feed caption block and wraps it before the buttons', () => {
    const way = textClearance('9:16', { x: 0.5, y: 0.82, widthFrac: 0.9 });
    expect(way).not.toBe('clear');
    const fixed = way as { y: number; widthFrac: number };
    expect(fixed.y).toBeLessThan(0.68);
    // The button column starts at x = 0.84: the box ends before it.
    expect(0.5 + fixed.widthFrac / 2).toBeLessThan(0.84);
    expect(textClearance('9:16', { x: 0.5, ...fixed })).toBe('clear');
  });

  it('agrees with where generated vertical captions are placed', () => {
    expect(textClearance('9:16', { x: 0.5, y: 0.62, widthFrac: 0.64 })).toBe('clear');
  });

  it('flags a full-width text that runs under the side buttons, not only one centred under them', () => {
    expect(textClearance('9:16', { x: 0.5, y: 0.6, widthFrac: 0.9 })).not.toBe('clear');
  });

  it('pushes a title out of the status bar downwards', () => {
    const way = textClearance('9:16', { x: 0.5, y: 0.05, widthFrac: 0.6 }) as { y: number };
    expect(way.y).toBeGreaterThan(0.11);
  });

  it('leaves a centred title alone, and gives up rather than squeeze a text to nothing', () => {
    expect(textClearance('9:16', { x: 0.5, y: 0.3, widthFrac: 0.9 })).toBe('clear');
    expect(textClearance('9:16', { x: 0.8, y: 0.6, widthFrac: 0.5 })).toBeNull();
  });
});

describe('reviewProject', () => {
  it('flags a caption under the feed interface, and offers the move when the position is static', () => {
    const p = project([lane('t', [title('cap', 0, 1000, 0.82), title('moving', 0, 1000, 0.82, { animation: { y: [{ t: 0, value: 0.82 }] } as Clip['animation'] })]), lane('v', [clip('c', 0, 1000)])]);
    const issue = review(p).find((i) => i.id === 'uiZone');
    expect(issue).toMatchObject({ id: 'uiZone', clipIds: ['cap', 'moving'] });
    // Only the static one is moved automatically: rewriting an animated
    // position would drop the animation.
    expect(issue && 'fixes' in issue && issue.fixes.map((f) => f.clipId)).toEqual(['cap']);
  });

  it('reads a partly written transform over the defaults', () => {
    const partial = title('cap', 0, 1000, 0.85, { transform: { y: 0.85 } as Clip['transform'] });
    expect(ids(project([lane('t', [partial]), lane('v', [clip('c', 0, 1000)])]))).toContain('uiZone');
  });

  it('only checks the platform interface when publishing to a platform', () => {
    const p = project([lane('t', [title('cap', 0, 1000, 0.82)]), lane('v', [clip('c', 0, 1000)])]);
    expect(ids(p, { target: 'video' })).not.toContain('uiZone');
  });

  it('flags letterboxed footage with nothing behind it, not a picture in picture', () => {
    const alone = project([lane('v', [clip('w', 0, 1000, { assetId: 'wide' })])]);
    const issue = review(alone).find((i) => i.id === 'letterbox');
    expect(issue).toMatchObject({ clipIds: ['w'] });
    expect(issue && 'fixes' in issue && issue.fixes[0]!.transform.scale).toBeGreaterThan(1);

    const pip = project([lane('top', [clip('w', 0, 1000, { assetId: 'wide' })]), lane('bg', [clip('c', 0, 1000)])]);
    expect(ids(pip)).not.toContain('letterbox');

    const handFramed = project([
      lane('v', [clip('w', 0, 1000, { assetId: 'wide', transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.3, y: 0.5, scale: 1 } })]),
    ]);
    expect(ids(handFramed)).not.toContain('letterbox');
  });

  it('asks for captions on spoken footage, and stops once there are some', () => {
    const bare = project([lane('v', [clip('c', 0, 1000)])]);
    expect(ids(bare)).toContain('noCaptions');
    const captioned = project([lane('t', [title('cap', 0, 1000, 0.6)]), lane('v', [clip('c', 0, 1000)])]);
    expect(ids(captioned)).not.toContain('noCaptions');
  });

  it('mentions the platform loudness only when it is off and there is sound', () => {
    const p = project([lane('v', [clip('c', 0, 1000)])]);
    expect(ids(p, { normalize: false })).toContain('loudness');
    expect(ids(p, { normalize: true })).not.toContain('loudness');
    const silent = project([lane('v', [clip('c', 0, 1000, { assetId: 'still' })])]);
    expect(
      reviewProject({
        project: silent,
        assets: { still: asset('still', { kind: 'image', hasAudio: false }) },
        region: null,
        target: 'social',
        normalize: false,
      }).map((i) => i.id),
    ).not.toContain('loudness');
  });

  it('reads the exported region, not the whole cut', () => {
    const p = project([lane('v', [clip('a', 0, 1000), clip('b', 2000, 1000)])]);
    expect(ids(p)).toContain('blackGaps');
    expect(ids(p, { region: { startMs: 0, endMs: 1000 } })).not.toContain('blackGaps');
  });

  it('keeps an audio export to what concerns sound', () => {
    const p = project([lane('t', [title('cap', 0, 1000, 0.82)]), lane('v', [clip('a', 500, 1000)])]);
    expect(ids(p, { target: 'audio' })).toEqual([]);
  });

  it('names the sources the export would refuse', () => {
    const p = project([lane('v', [clip('c', 0, 1000)])]);
    const issues = reviewProject({
      project: p,
      assets: { cam: asset('cam', { disconnected: true }) },
      region: null,
      target: 'video',
      normalize: true,
    });
    expect(issues[0]).toEqual({ id: 'disconnected', names: ['cam.mp4'] });
  });
});
