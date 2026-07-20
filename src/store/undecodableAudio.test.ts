import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { isTrackPlayable } from '../types';

/**
 * Audio tracks the browser cannot decode (E-AC-3, AC-3, DTS). They are listed
 * on the asset so the UI can offer a transcode, but must stay out of the
 * timeline and the mix until that transcode has actually run. Store bootstrapped
 * like imageAssets.test.ts (node environment, stubbed DOM bits).
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown; structuredClone: typeof structuredClone };
  g.document ??= { documentElement: {} };
  g.structuredClone = (<T>(v: T): T => JSON.parse(JSON.stringify(v)) as T) as typeof structuredClone;
  ({ useStore } = await import('./store'));
});

/** A video with one decodable AAC track and one undecodable E-AC-3 track. */
function mixedAsset(id = 'vid'): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mkv`),
    kind: 'video',
    durationMs: 10_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioTracks: [
      { index: 0, channels: 2, codec: 'mp4a.40.2' },
      { index: 1, channels: 6, codec: 'eac3', undecodable: true, language: 'jpn' },
    ],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const audioClips = () =>
  s()
    .project.tracks.filter((tr) => tr.kind === 'audio')
    .flatMap((tr) => tr.clips);

beforeEach(() => {
  s().resetProject();
});

describe('isTrackPlayable', () => {
  it('accepts a normal track and rejects an untranscoded undecodable one', () => {
    expect(isTrackPlayable({ index: 0, channels: 2 })).toBe(true);
    expect(isTrackPlayable({ index: 1, channels: 6, undecodable: true })).toBe(false);
  });

  it('accepts an undecodable track once transcoded', () => {
    expect(isTrackPlayable({ index: 1, channels: 6, undecodable: true, transcoded: true })).toBe(
      true,
    );
  });
});

describe('placing a clip whose source has an undecodable track', () => {
  beforeEach(() => {
    s().addAsset(mixedAsset());
    s().addClipFromAsset('vid');
  });

  it('lays down a lane for the decodable track only', () => {
    expect(audioClips()).toHaveLength(1);
    expect(audioClips()[0]!.audioTrackIndex).toBe(0);
  });

  it('leaves no silent clip for the E-AC-3 track', () => {
    expect(audioClips().some((c) => c.audioTrackIndex === 1)).toBe(false);
  });
});

describe('attachAudioTrack (what a finished transcode calls)', () => {
  beforeEach(() => {
    s().addAsset(mixedAsset());
    s().addClipFromAsset('vid');
    // Stand in for the transcode: the store marks the track playable, then
    // asks for the lane that could not exist at drop time.
    const asset = s().assets['vid']!;
    s().addAsset({
      ...asset,
      audioTracks: asset.audioTracks.map((tr) =>
        tr.index === 1 ? { ...tr, transcoded: true } : tr,
      ),
    });
    s().attachAudioTrack('vid', 1);
  });

  it('adds the missing audio clip for the transcoded track', () => {
    expect(audioClips()).toHaveLength(2);
    expect(audioClips().map((c) => c.audioTrackIndex).sort()).toEqual([0, 1]);
  });

  it('links the new clip to the picture clip it belongs to', () => {
    const video = s()
      .project.tracks.filter((tr) => tr.kind === 'video')
      .flatMap((tr) => tr.clips)[0]!;
    const added = audioClips().find((c) => c.audioTrackIndex === 1)!;
    expect(added.linkId).toBeTruthy();
    expect(added.linkId).toBe(video.linkId);
  });

  it('is idempotent: running the transcode twice adds no duplicate', () => {
    s().attachAudioTrack('vid', 1);
    expect(audioClips()).toHaveLength(2);
  });

});

describe('attachAudioTrack on a clip that was already trimmed', () => {
  it('matches the picture clip trim rather than the full source duration', () => {
    s().addAsset(mixedAsset());
    s().addClipFromAsset('vid');
    const video = s()
      .project.tracks.filter((tr) => tr.kind === 'video')
      .flatMap((tr) => tr.clips)[0]!;
    s().updateClipCommitted(video.id, { sourceInMs: 2000, sourceOutMs: 6000 });

    const asset = s().assets['vid']!;
    s().addAsset({
      ...asset,
      audioTracks: asset.audioTracks.map((tr) =>
        tr.index === 1 ? { ...tr, transcoded: true } : tr,
      ),
    });
    s().attachAudioTrack('vid', 1);

    const added = audioClips().find((c) => c.audioTrackIndex === 1)!;
    expect(added.sourceInMs).toBe(2000);
    expect(added.sourceOutMs).toBe(6000);
  });
});

describe('an asset whose only audio track is undecodable', () => {
  beforeEach(() => {
    s().addAsset({
      ...mixedAsset('only'),
      hasAudio: false,
      audioTracks: [{ index: 0, channels: 6, codec: 'eac3', undecodable: true }],
    });
    s().addClipFromAsset('only');
  });

  it('places the picture with no audio lane and no link id', () => {
    expect(audioClips()).toHaveLength(0);
    const video = s()
      .project.tracks.filter((tr) => tr.kind === 'video')
      .flatMap((tr) => tr.clips)[0]!;
    expect(video.linkId).toBeUndefined();
  });

  it('gains a linked audio clip once the track is transcoded', () => {
    const asset = s().assets['only']!;
    s().addAsset({
      ...asset,
      hasAudio: true,
      audioTracks: [{ ...asset.audioTracks[0]!, transcoded: true }],
    });
    s().attachAudioTrack('only', 0);
    expect(audioClips()).toHaveLength(1);
    expect(audioClips()[0]!.linkId).toBeTruthy();
  });
});
