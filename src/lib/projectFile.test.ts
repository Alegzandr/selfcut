import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { MediaAsset, Project } from '../types';

/**
 * The `.selfcut` document: what survives a round-trip, and what a malformed or
 * too-new file must not be allowed to do. The store is stubbed out - the parser
 * only borrows the project validator from the persistence module, which pulls
 * the store in transitively.
 */

vi.mock('../store/store', () => ({ useStore: { getState: () => ({ setError: () => undefined }) } }));
vi.mock('../media/probe', () => ({ ensureAssetVisuals: () => undefined }));

let projectFile: typeof import('./projectFile');
let isMissingSource: typeof import('./missingSource').isMissingSource;

beforeAll(async () => {
  const g = globalThis as { document?: unknown; window?: unknown };
  g.document ??= { documentElement: {} };
  g.window ??= {};
  projectFile = await import('./projectFile');
  ({ isMissingSource } = await import('./missingSource'));
});

function project(): Project {
  return {
    id: 'proj-1',
    aspectRatio: '16:9',
    fps: 60,
    markers: [{ id: 'm1', timeMs: 1500, label: 'intro' }],
    tracks: [
      {
        id: 'tr-v',
        kind: 'video',
        volume: 0.8,
        clips: [
          {
            id: 'c1',
            kind: 'media',
            assetId: 'a1',
            trackId: 'tr-v',
            timelineStartMs: 0,
            sourceInMs: 200,
            sourceOutMs: 4200,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 250,
            linkId: 'lnk-1',
            transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.5, scale: 1.2 },
          },
        ],
      },
    ],
  };
}

function asset(): MediaAsset {
  return {
    id: 'a1',
    file: new File([new Uint8Array([1, 2, 3])], 'take-01.mp4', { lastModified: 1700000000000 }),
    kind: 'video',
    durationMs: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    audioTracks: [{ index: 0, channels: 2, language: 'fra', peaks: [0.1, 0.9] }],
    thumbnails: ['data:image/webp;base64,AAAA'],
  };
}

/** Round-trip a one-asset project and hand back that asset, narrowed. */
function restoredAsset(): MediaAsset {
  const json = projectFile.serializeProject(project(), { a1: asset() });
  const [restored] = projectFile.parseProjectFile(json).assets;
  if (!restored) throw new Error('the asset did not survive the round-trip');
  return restored;
}

describe('project file', () => {
  it('round-trips the timeline untouched', () => {
    const p = project();
    const json = projectFile.serializeProject(p, { a1: asset() });
    expect(projectFile.parseProjectFile(json).project).toEqual(p);
  });

  it('keeps the metadata needed to draw the timeline before relinking', () => {
    expect(restoredAsset()).toMatchObject({
      id: 'a1',
      kind: 'video',
      durationMs: 5000,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      thumbnails: ['data:image/webp;base64,AAAA'],
      audioTracks: [{ index: 0, channels: 2, language: 'fra', peaks: [0.1, 0.9] }],
    });
  });

  it('brings assets back disconnected, under a recognizable placeholder', () => {
    const restored = restoredAsset();
    expect(restored.disconnected).toBe(true);
    // The name is what the relink banner matches the picked files on.
    expect(restored.file.name).toBe('take-01.mp4');
    expect(restored.file.size).toBe(0);
    expect(isMissingSource(restored.file)).toBe(true);
  });

  it('does not mistake a real file for a missing source', () => {
    expect(isMissingSource(asset().file)).toBe(false);
  });

  it('carries no media bytes', () => {
    const big = asset();
    const json = projectFile.serializeProject(project(), { a1: big });
    expect(json).not.toContain('base64,/9j/');
    expect(JSON.parse(json).assets[0].file).toBeUndefined();
    expect(JSON.parse(json).assets[0].source).toEqual({
      name: 'take-01.mp4',
      size: 3,
      lastModified: 1700000000000,
    });
  });

  it('rejects JSON that is not a project file', () => {
    expect(() => projectFile.parseProjectFile('{"hello":true}')).toThrow(projectFile.ProjectFileError);
    expect(() => projectFile.parseProjectFile('not json')).toThrow(projectFile.ProjectFileError);
  });

  it('rejects a file written by a newer version rather than silently dropping what it holds', () => {
    const doc = JSON.parse(projectFile.serializeProject(project(), {}));
    doc.version = 99;
    expect(() => projectFile.parseProjectFile(JSON.stringify(doc))).toThrow(
      projectFile.ProjectFileError,
    );
  });

  it('rejects a document whose project is corrupt', () => {
    const doc = JSON.parse(projectFile.serializeProject(project(), {}));
    doc.project.tracks = 'not an array';
    expect(() => projectFile.parseProjectFile(JSON.stringify(doc))).toThrow(
      projectFile.ProjectFileError,
    );
  });

  it('drops a malformed asset entry but keeps the project loadable', () => {
    const doc = JSON.parse(projectFile.serializeProject(project(), { a1: asset() }));
    doc.assets.push({ id: 'broken' });
    const parsed = projectFile.parseProjectFile(JSON.stringify(doc));
    expect(parsed.assets.map((a) => a.id)).toEqual(['a1']);
    expect(parsed.project.tracks).toHaveLength(1);
  });
});
