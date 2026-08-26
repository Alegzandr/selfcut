import { beforeAll, describe, expect, it } from 'vitest';
import type { Clip, Project, TextClip } from '../types';

/**
 * What the timeline hands the serializer. The cues live as clips while they are
 * being edited, so this is where a moved, retimed or repositioned caption turns
 * back into something a subtitle file can state.
 *
 * The i18n module reaches for the DOM on import (the fallback filename is
 * localized), hence the stubs - same dance as the preset file tests.
 */

let sx: typeof import('./subtitleExport');

beforeAll(async () => {
  const g = globalThis as { document?: unknown; window?: unknown };
  g.document ??= { documentElement: {} };
  g.window ??= {};
  sx = await import('./subtitleExport');
});

function text(id: string, startMs: number, endMs: number, over: Partial<TextClip> = {}): Clip {
  return {
    kind: 'text',
    id,
    assetId: '',
    trackId: 'captions',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: endMs - startMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.82, scale: 1 },
    text: { content: id, color: '#ffffff', sizeFrac: 0.05 },
    ...over,
  } as Clip;
}

const project = (clips: Clip[]): Project => ({
  id: 'p',
  aspectRatio: '16:9',
  fps: 30,
  markers: [],
  tracks: [{ id: 'captions', kind: 'video', clips }],
});

describe('cuesFromProject', () => {
  it('reads every text clip in timeline order, whatever lane it sits on', () => {
    const p: Project = {
      ...project([text('late', 5000, 6000)]),
      tracks: [
        { id: 'captions', kind: 'video', clips: [text('late', 5000, 6000)] },
        { id: 'titles', kind: 'video', clips: [text('early', 0, 1000)] },
      ],
    };
    expect(sx.cuesFromProject(p).map((c) => c.text)).toEqual(['early', 'late']);
  });

  it('takes the edited timing, not the imported one', () => {
    // A cue dragged and trimmed on the timeline exports where it now plays.
    const cues = sx.cuesFromProject(project([text('moved', 2500, 4200)]));
    expect(cues).toEqual([{ startMs: 2500, endMs: 4200, text: 'moved' }]);
  });

  it('states a placement only when the clip left the caption default', () => {
    const clips = [
      text('top', 0, 1000, {
        transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.14, scale: 1 },
        text: { content: 'top', color: '#fff', sizeFrac: 0.05, align: 'left' },
      }),
      text('plain', 1000, 2000),
      text('centered', 2000, 3000, {
        text: { content: 'centered', color: '#fff', sizeFrac: 0.05, align: 'center' },
      }),
    ];
    expect(sx.cuesFromProject(project(clips))).toEqual([
      { startMs: 0, endMs: 1000, text: 'top', align: 'left', vAlign: 'top' },
      { startMs: 1000, endMs: 2000, text: 'plain' },
      { startMs: 2000, endMs: 3000, text: 'centered' },
    ]);
  });

  it('skips a cue emptied by editing', () => {
    // An empty text clip renders nothing; a blank cue in the file would be a
    // gap a player shows as a flash of empty caption box.
    const blank = text('blank', 0, 1000, {
      text: { content: '   ', color: '#fff', sizeFrac: 0.05 },
    });
    expect(sx.cuesFromProject(project([blank]))).toEqual([]);
  });
});

describe('subtitleFileName', () => {
  it('names the file after the project, without its project extension', () => {
    expect(sx.subtitleFileName('My film.selfcut', 'srt')).toBe('My film.srt');
    expect(sx.subtitleFileName('My film', 'vtt')).toBe('My film.vtt');
  });

  it('falls back when the project is unnamed', () => {
    expect(sx.subtitleFileName(undefined, 'srt')).toBe('subtitles.srt');
    expect(sx.subtitleFileName('  ', 'srt')).toBe('subtitles.srt');
  });
});
