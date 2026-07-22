import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Remuxing an unreadable container into Matroska. The ffmpeg runtime itself is
 * mocked - what is under test is the argument shape, the subtitle-drop fallback
 * and the identity the rescued blob is handed back with, none of which need a
 * real 32 MB core to exercise.
 */

const runFFmpegJob = vi.fn();

vi.mock('./ffmpeg', async () => {
  const actual = await vi.importActual<typeof import('./ffmpeg')>('./ffmpeg');
  return { ...actual, runFFmpegJob };
});

const { remuxUnreadableContainer } = await import('./remuxContainer');
const { FFmpegLoadFailed } = await import('./ffmpeg');

const source = () => new File([new Uint8Array([1, 2, 3])], 'clip.avi', { lastModified: 42 });
const mkvBytes = new Uint8Array([9, 9, 9]);

/** The `-map ... -c copy -f matroska` args the job was actually run with. */
function argsOf(call: number): string[] {
  return runFFmpegJob.mock.calls[call]![0].args;
}

beforeEach(() => runFFmpegJob.mockReset());

describe('remuxUnreadableContainer', () => {
  it('stream-copies video, audio and subtitles into Matroska on the first try', async () => {
    runFFmpegJob.mockResolvedValueOnce([mkvBytes]);

    const out = await remuxUnreadableContainer(source());

    expect(runFFmpegJob).toHaveBeenCalledTimes(1);
    const args = argsOf(0);
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args.slice(args.indexOf('-f'))).toEqual(['-f', 'matroska', 'remux.mkv']);
    // Subtitles are mapped on the first attempt.
    expect(args).toContain('0:s?');
    expect(out).toBeInstanceOf(File);
  });

  it('keeps the source name and mtime so caches and the library still recognize it', async () => {
    runFFmpegJob.mockResolvedValueOnce([mkvBytes]);

    const out = await remuxUnreadableContainer(source());

    expect(out!.name).toBe('clip.avi');
    expect(out!.lastModified).toBe(42);
    expect(new Uint8Array(await out!.arrayBuffer())).toEqual(mkvBytes);
  });

  it('drops the subtitles and retries when the first copy fails', async () => {
    runFFmpegJob.mockRejectedValueOnce(new Error('subtitle codec refused')).mockResolvedValueOnce([
      mkvBytes,
    ]);

    const out = await remuxUnreadableContainer(source());

    expect(runFFmpegJob).toHaveBeenCalledTimes(2);
    // The retry no longer asks for subtitle streams.
    expect(argsOf(0)).toContain('0:s?');
    expect(argsOf(1)).not.toContain('0:s?');
    expect(out).toBeInstanceOf(File);
  });

  it('returns null when ffmpeg cannot demux the file even without subtitles', async () => {
    runFFmpegJob
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('still boom'));

    expect(await remuxUnreadableContainer(source())).toBeNull();
  });

  it('rethrows a converter-load failure instead of masking it as an unusable file', async () => {
    runFFmpegJob.mockRejectedValueOnce(new FFmpegLoadFailed(new Error('core never loaded')));

    await expect(remuxUnreadableContainer(source())).rejects.toBeInstanceOf(FFmpegLoadFailed);
    // No pointless retry once the runtime itself is down.
    expect(runFFmpegJob).toHaveBeenCalledTimes(1);
  });
});
