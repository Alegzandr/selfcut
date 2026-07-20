import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { MediaAsset } from '../types';

/**
 * Reconnecting an asset to another file: the id is reused so clips stay linked,
 * and a shorter replacement clamps the source windows it can no longer cover.
 * The probe is stubbed - decoding a real file is out of scope here. Store
 * bootstrapped like imageAssets.test.ts (node environment, stubbed DOM bits).
 */

const probed = vi.fn();

vi.mock('../media/probe', () => ({
  probeFile: (file: File, reuseId?: string) => probed(file, reuseId),
  ensureAssetVisuals: () => undefined,
}));

vi.mock('../media/mediaCache', () => ({
  disposeAssetResources: () => undefined,
  registerInput: () => undefined,
  resetStillFrame: () => undefined,
  disposeUnreachableAssets: () => undefined,
}));

let useStore: typeof import('./store').useStore;
let confirmResult = true;

beforeAll(async () => {
  const g = globalThis as {
    document?: unknown;
    window?: unknown;
    structuredClone: typeof structuredClone;
  };
  g.document ??= { documentElement: {} };
  g.window ??= {};
  g.structuredClone = (<T>(v: T): T => JSON.parse(JSON.stringify(v)) as T) as typeof structuredClone;
  ({ useStore } = await import('./store'));
  // Stand in for <ConfirmDialog>: answer whatever the store asks with the
  // verdict the test set, so `reconnectAsset` is never left awaiting.
  useStore.subscribe((state) => {
    if (state.confirmDialog) state.resolveConfirm(confirmResult);
  });
});

function videoAsset(id: string, durationMs: number, name = `${id}.mp4`): MediaAsset {
  return {
    id,
    file: new File([], name),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
}

const s = () => useStore.getState();
const clips = () => s().project.tracks.flatMap((t) => t.clips);
const mediaClip = () => clips().find((c) => c.assetId === 'v')!;

beforeEach(() => {
  confirmResult = true;
  probed.mockReset();
  s().resetProject();
  s().addAsset(videoAsset('v', 10_000));
  s().addClipFromAsset('v');
});

describe('reconnectAsset', () => {
  it('swaps the file under the same id, leaving clips linked and untouched', async () => {
    const before = mediaClip();
    probed.mockResolvedValue({ asset: videoAsset('v', 10_000, 'renamed.mp4'), warning: null });

    await s().reconnectAsset('v', new File([], 'renamed.mp4'));

    expect(probed).toHaveBeenCalledWith(expect.any(File), 'v');
    expect(s().assets.v!.file.name).toBe('renamed.mp4');
    expect(mediaClip().id).toBe(before.id);
    expect(mediaClip().sourceOutMs).toBe(before.sourceOutMs);
  });

  it('clears the disconnected flag', async () => {
    s().addAsset({ ...videoAsset('v', 10_000), disconnected: true });
    probed.mockResolvedValue({ asset: videoAsset('v', 10_000), warning: null });

    await s().reconnectAsset('v', new File([], 'v.mp4'));

    expect(s().assets.v!.disconnected).toBeUndefined();
  });

  it('clamps clips that overrun a shorter replacement, once confirmed', async () => {
    expect(mediaClip().sourceOutMs).toBe(10_000);
    probed.mockResolvedValue({ asset: videoAsset('v', 4000), warning: null });

    await s().reconnectAsset('v', new File([], 'short.mp4'));

    expect(s().assets.v!.durationMs).toBe(4000);
    expect(mediaClip().sourceOutMs).toBe(4000);
  });

  it('keeps the original when the mismatch warning is declined', async () => {
    confirmResult = false;
    probed.mockResolvedValue({ asset: videoAsset('v', 4000), warning: null });

    await s().reconnectAsset('v', new File([], 'short.mp4'));

    expect(s().assets.v!.durationMs).toBe(10_000);
    expect(mediaClip().sourceOutMs).toBe(10_000);
  });

  it('leaves a longer replacement alone: no clip is stretched', async () => {
    probed.mockResolvedValue({ asset: videoAsset('v', 30_000), warning: null });

    await s().reconnectAsset('v', new File([], 'long.mp4'));

    expect(s().assets.v!.durationMs).toBe(30_000);
    expect(mediaClip().sourceOutMs).toBe(10_000);
  });

  it('does nothing when the asset was removed while the dialog was open', async () => {
    probed.mockImplementation(async () => {
      s().removeAsset('v');
      return { asset: videoAsset('v', 4000), warning: null };
    });

    await s().reconnectAsset('v', new File([], 'short.mp4'));

    expect(s().assets.v).toBeUndefined();
  });
});
