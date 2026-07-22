import { FFmpegLoadFailed, runFFmpegJob, type FFmpegProgress } from './ffmpeg';

/**
 * Rescue a container the browser's own demuxer (mediabunny) cannot read by
 * remuxing it into Matroska, without touching the streams inside.
 *
 * This is the cheap half of "support what ffmpeg supports": it is a stream copy,
 * not a re-encode. The packets are lifted from a container mediabunny never
 * recognized - AVI, MPEG-TS/PS, FLV, ASF/WMV, OGV, RealMedia, exotic MOV - into
 * one it reads, and nothing about them is decoded, converted or recompressed. A
 * VC-1 stream out of an unreadable .wmv becomes a VC-1 stream in a readable .mkv:
 * no more decodable than before, but now VISIBLE to the rest of the pipeline, so
 * its audio, its subtitles and its metadata all come in whenever the codecs are
 * ones the browser can actually play. Whether the picture then decodes is the
 * ordinary capability question the caller already answers (see probe): an
 * undecodable codec still degrades to audio-only, exactly as it would have if the
 * container had been readable in the first place.
 *
 * Matroska is the target on purpose. It accepts virtually every codec, so the
 * copy almost never fails for lack of a home for a stream - where MP4 would
 * refuse VC-1, MPEG-2 or PCM outright and take the whole rescue down with it.
 *
 * Re-encoding an undecodable codec is a different, heavier operation and
 * deliberately not done here: this path exists to be nearly free.
 */

/** The remuxed container inside ffmpeg's virtual filesystem. */
const REMUX_OUTPUT = 'remux.mkv';

/**
 * Map video, audio and subtitle streams, each optional, and drop everything
 * else. `?` on each specifier means a source missing that stream type does not
 * fail the job. Data and attachment streams (timecode tracks, cover art, embedded
 * fonts) carry nothing the timeline uses and are the streams most likely to
 * refuse a copy into Matroska - dropping them removes a failure mode for no loss.
 */
const MAP_AV_SUBS = ['-map', '0:v?', '-map', '0:a?', '-map', '0:s?'];
const MAP_AV = ['-map', '0:v?', '-map', '0:a?'];
const COPY_TO_MKV = ['-c', 'copy', '-f', 'matroska', REMUX_OUTPUT];

/**
 * Remux an unreadable container into a Matroska File, or null when ffmpeg cannot
 * make usable media out of it.
 *
 * Rethrows FFmpegLoadFailed rather than swallowing it: a converter that never
 * came up is not a property of this file, and the caller has to tell "the
 * converter is down" apart from "this file is not media", because they are
 * different messages and only one of them is worth a retry.
 */
export async function remuxUnreadableContainer(
  file: File,
  { onProgress }: { onProgress?: (progress: FFmpegProgress) => void } = {},
): Promise<File | null> {
  const run = (args: string[]) =>
    runFFmpegJob({ file, args, outputs: [REMUX_OUTPUT], onProgress });

  let bytes: Uint8Array;
  try {
    [bytes] = (await run([...MAP_AV_SUBS, ...COPY_TO_MKV])) as [Uint8Array];
  } catch (err) {
    if (err instanceof FFmpegLoadFailed) throw err;
    // A stream refused the copy - almost always a subtitle codec Matroska will
    // not carry as-is. Retry with the picture and sound alone: getting the file
    // onto the timeline is what matters, and losing an embedded caption track to
    // keep the video is the right trade. Safe to retry on the same runtime - a
    // trapped instance is discarded where it trapped, so this gets a fresh one.
    try {
      [bytes] = (await run([...MAP_AV, ...COPY_TO_MKV])) as [Uint8Array];
    } catch (retryErr) {
      if (retryErr instanceof FFmpegLoadFailed) throw retryErr;
      // ffmpeg cannot demux it either: this is not media the app can use.
      console.warn('container remux failed', retryErr);
      return null;
    }
  }

  // Keep the source's name and mtime on the remuxed blob. The user recognizes
  // the file they picked, and the on-disk caches (lib/mediaKey.ts) key on that
  // identity. The bytes are Matroska now whatever the extension reads - mediabunny
  // and ffmpeg both detect a container by its content, never by its name.
  return new File([bytes as BlobPart], file.name, {
    lastModified: file.lastModified,
    type: 'video/x-matroska',
  });
}
