import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionStorageError, downloadCaptionModel } from './captionsDownload';
import { captionModel } from './captionsModel';

const files = vi.fn<() => Promise<string[]>>();
const metadata = vi.fn<(repo: string, file: string) => Promise<{ exists: boolean; size?: number }>>();

vi.mock('@huggingface/transformers', () => ({
  env: {},
  ModelRegistry: {
    get_pipeline_files: () => files(),
    get_file_metadata: (repo: string, file: string) => metadata(repo, file),
  },
}));

/** A Cache Storage stand-in: the store is what the assertions read. */
function fakeCache(putFails = false) {
  const store = new Map<string, Response>();
  const put = vi.fn(async (url: string, res: Response) => {
    if (putFails) throw new DOMException('quota', 'QuotaExceededError');
    // Drain the body the way the real one does, so the progress transform runs.
    await res.arrayBuffer();
    store.set(url, res);
  });
  const cache = {
    put,
    match: async (url: string) => store.get(url),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return { store, put };
}

const base = captionModel('base');

beforeEach(() => {
  vi.unstubAllGlobals();
  files.mockResolvedValue(['config.json', 'onnx/encoder_model_fp16.onnx']);
  metadata.mockResolvedValue({ exists: true, size: 4 });
  vi.stubGlobal('fetch', async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-length': '4' },
    }),
  );
});

describe('downloadCaptionModel', () => {
  it('stores every file under the URL transformers.js will look it up by', async () => {
    // The key IS the contract: a mismatch here downloads the model twice, once
    // into a cache nobody reads and once for real.
    const { store } = fakeCache();
    const progress: number[] = [];
    await downloadCaptionModel(base, 'webgpu', 'fp16', (v) => progress.push(v));

    expect([...store.keys()]).toEqual([
      `https://huggingface.co/${base.repo}/resolve/main/config.json`,
      `https://huggingface.co/${base.repo}/resolve/main/onnx/encoder_model_fp16.onnx`,
    ]);
    expect(progress.at(-1)).toBe(1);
  });

  it('picks up where an interrupted run stopped', async () => {
    const { store, put } = fakeCache();
    store.set(
      `https://huggingface.co/${base.repo}/resolve/main/config.json`,
      new Response(),
    );
    await downloadCaptionModel(base, 'webgpu', 'fp16', () => {});
    // Only the file that was missing: re-fetching hundreds of megabytes because
    // the tab was closed is the failure this whole path exists to avoid.
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('reports a refused cache write as its own kind of failure', async () => {
    fakeCache(true);
    await expect(
      downloadCaptionModel(base, 'webgpu', 'fp16', () => {}),
    ).rejects.toBeInstanceOf(CaptionStorageError);
  });

  it('fails on a missing weight file and shrugs off a missing config', async () => {
    fakeCache();
    metadata.mockImplementation(async (_repo, file) => ({
      exists: !file.endsWith('.onnx'),
      size: 4,
    }));
    await expect(
      downloadCaptionModel(base, 'webgpu', 'fp16', () => {}),
    ).rejects.toThrow(/encoder_model_fp16\.onnx/);

    files.mockResolvedValue(['config.json', 'generation_config.json']);
    metadata.mockImplementation(async (_repo, file) => ({
      exists: file === 'config.json',
      size: 4,
    }));
    await expect(
      downloadCaptionModel(base, 'webgpu', 'fp16', () => {}),
    ).resolves.toBeUndefined();
  });

  it('does not pretend to have stored what the cache dropped', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({ put: async () => {}, match: async (u: string) => store.get(u) }),
    });
    await expect(
      downloadCaptionModel(base, 'webgpu', 'fp16', () => {}),
    ).rejects.toBeInstanceOf(CaptionStorageError);
  });
});
