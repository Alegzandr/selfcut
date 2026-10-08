import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';

/**
 * The store side of the auto-balance: the batch volume write is ONE undo step,
 * and the target resolution finds the clip whose volume actually carries the
 * sound - the audio member of a link group, deduped across a selection that
 * names both halves.
 */

let useStore: typeof import('./store').useStore;
let balanceTargets: typeof import('../ui/volumeBalanceActions').balanceTargets;
let isolateShot: typeof import('../ui/volumeBalanceActions').isolateShot;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
  ({ balanceTargets, isolateShot } = await import('../ui/volumeBalanceActions'));
});

function asset(id: string, kind: 'video' | 'audio', hasAudio: boolean): MediaAsset {
  return {
    id,
    file: new File([], `${id}.${kind === 'video' ? 'mp4' : 'mp3'}`),
    kind,
    durationMs: 5000,
    width: kind === 'video' ? 1920 : undefined,
    height: kind === 'video' ? 1080 : undefined,
    hasAudio,
    audioTracks: hasAudio ? [{ index: 0, channels: 2 }] : [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const clips = () => s().project.tracks.flatMap((t) => t.clips);
const byAsset = (assetId: string, kind: 'video' | 'audio') =>
  s().project.tracks.find((t) => t.kind === kind)!.clips.find((c) => c.assetId === assetId)!;

beforeEach(() => {
  s().resetProject();
  s().addAsset(asset('av', 'video', true));
  s().addAsset(asset('music', 'audio', true));
  s().addAsset(asset('silent', 'video', false));
  s().addClipFromAsset('av');
  s().addClipFromAsset('music');
  s().addClipFromAsset('silent');
});

describe('setClipVolumes', () => {
  it('writes every volume and undoes them together', () => {
    const music = byAsset('music', 'audio');
    const voice = byAsset('av', 'audio');
    const before = s().past.length;
    s().setClipVolumes({ [music.id]: 0.5, [voice.id]: 2 });
    expect(byAsset('music', 'audio').volume).toBe(0.5);
    expect(byAsset('av', 'audio').volume).toBe(2);
    expect(s().past.length).toBe(before + 1);
    s().undo();
    expect(byAsset('music', 'audio').volume).toBe(1);
    expect(byAsset('av', 'audio').volume).toBe(1);
  });

  it('skips ids that no longer exist and writes nothing for an empty batch', () => {
    const before = s().past.length;
    s().setClipVolumes({});
    expect(s().past.length).toBe(before);
    const music = byAsset('music', 'audio');
    s().setClipVolumes({ gone: 0.2, [music.id]: 0.3 });
    expect(byAsset('music', 'audio').volume).toBe(0.3);
  });
});

describe('balanceTargets', () => {
  it('resolves a linked video clip to its audio partner, once', () => {
    const video = byAsset('av', 'video');
    const audio = byAsset('av', 'audio');
    expect(video.linkId).toBeDefined();
    const targets = balanceTargets(s().project, s().assets, [video.id, audio.id]);
    expect(targets.map((t) => t.clip.id)).toEqual([audio.id]);
  });

  it('balances every mic of a two-mic take together, as one shot', () => {
    s().addAsset({
      ...asset('cam2', 'video', true),
      audioTracks: [
        { index: 1, channels: 1 },
        { index: 2, channels: 1 },
      ],
    } as MediaAsset);
    s().addClipFromAsset('cam2');
    const video = s().project.tracks.find((t) => t.kind === 'video')!.clips.find((c) => c.assetId === 'cam2')!;
    const mics = clips().filter((c) => c.assetId === 'cam2' && c.id !== video.id);
    expect(mics).toHaveLength(2);
    const targets = balanceTargets(s().project, s().assets, [video.id, mics[1]!.id]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.members.map((c) => c.id).sort()).toEqual(mics.map((c) => c.id).sort());
  });

  it('drops clips with no sound behind them', () => {
    const ids = clips().map((c) => c.id);
    const targets = balanceTargets(s().project, s().assets, ids);
    expect(targets.map((t) => t.asset.id).sort()).toEqual(['av', 'music']);
  });

  it('drops a clip whose track the browser cannot decode', () => {
    const a = s().assets['music']!;
    s().addAsset({ ...a, audioTracks: [{ index: 0, channels: 2, undecodable: true }] });
    const music = byAsset('music', 'audio');
    expect(balanceTargets(s().project, s().assets, [music.id])).toEqual([]);
  });

  it('ignores ids it cannot find', () => {
    expect(balanceTargets(s().project, s().assets, ['nope'])).toEqual([]);
  });
});

describe('isolateShot', () => {
  it('keeps only the shot, at its scaled volume, without the mix around it', () => {
    const voice = byAsset('av', 'audio');
    s().updateClipCommitted(voice.id, { volume: 0.5, fadeInMs: 300, mono: true });
    const lane = s().project.tracks.find((t) => t.clips.some((c) => c.id === voice.id))!;
    const project = {
      ...s().project,
      tracks: s().project.tracks.map((t) => (t.id === lane.id ? { ...t, muted: true, volume: 0.2 } : t)),
    };
    const shot = isolateShot(project, [byAsset('av', 'audio')], 2);
    expect(shot.project.tracks).toHaveLength(1);
    const [track] = shot.project.tracks;
    expect(track!.muted).toBe(false);
    expect(track!.volume).toBe(1);
    expect(track!.clips).toHaveLength(1);
    // Volume scaled, fades dropped, everything else the clip plays with kept.
    expect(track!.clips[0]).toMatchObject({ volume: 1, fadeInMs: 0, mono: true });
    expect(shot.durationMs).toBeGreaterThan(0);
  });
});
