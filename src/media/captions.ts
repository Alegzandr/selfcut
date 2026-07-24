import { Clip, MediaAsset } from '../types';
import type { SubtitleCue } from '../lib/subtitles';
import { clipDurationMs, clipEndMs } from '../model';
import { getAudioBuffer } from './mediaCache';
import type { CaptionReply, CaptionRequest, CaptionSegment } from './captionsProtocol';

/**
 * Local auto-captions (desktop only): transcribe a clip's audio with Whisper (in
 * a worker) and turn the result into subtitle cues, ready for `addSubtitleClips`.
 * The audio is decoded, downmixed and resampled to mono 16 kHz here and
 * transferred to the worker — nothing leaves the browser.
 */

export interface CaptionProgress {
  /** 'model' while the weights download (first run), 'transcribe' while running. */
  stage: 'model' | 'transcribe';
  /** 0..1 for the model download; 1 (indeterminate) while transcribing. */
  value: number;
}

let worker: Worker | null = null;
function ensureWorker(): Worker {
  worker ??= new Worker(new URL('./captionsWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

/** Whisper wants mono 16 kHz: render the clip's source span through an offline
 * context, which resamples and downmixes to one channel in one pass. */
async function extractMono16k(
  buffer: AudioBuffer,
  startSec: number,
  durationSec: number,
): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil(durationSec * 16000));
  const ctx = new OfflineAudioContext(1, frames, 16000);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, Math.max(0, startSec), durationSec);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/**
 * Map Whisper segments (seconds, audio-relative) to timeline cues for `clip`,
 * accounting for its speed and clamping to its span. A segment with no end time
 * borrows the next one's start (or a short default on the last).
 */
export function segmentsToCues(segments: CaptionSegment[], clip: Clip): SubtitleCue[] {
  const speed = clip.speed || 1;
  const end = clipEndMs(clip);
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const startMs = clip.timelineStartMs + (s.startSec * 1000) / speed;
    if (startMs >= end) continue;
    const rawEndSec = s.endSec ?? segments[i + 1]?.startSec ?? s.startSec + 2;
    let endMs = clip.timelineStartMs + (rawEndSec * 1000) / speed;
    endMs = Math.min(endMs, end);
    if (endMs <= startMs) endMs = Math.min(startMs + 500, end);
    cues.push({ startMs, endMs, text: s.text });
  }
  return cues;
}

/**
 * Transcribe `clip` and return its cues, or null (no audio, aborted, or the clip
 * has no real duration). `language` is a Whisper code ('en', 'fr'…) or omitted to
 * auto-detect. Cancelling terminates the worker so the transcription stops.
 */
export async function generateCaptions(
  clip: Clip,
  asset: MediaAsset,
  opts: { language?: string },
  onProgress: (p: CaptionProgress) => void,
  signal?: AbortSignal,
): Promise<SubtitleCue[] | null> {
  if (!asset.hasAudio || clipDurationMs(clip) <= 0) return null;
  const buffer = await getAudioBuffer(asset, clip.audioTrackIndex);
  if (!buffer || signal?.aborted) return null;

  const audio = await extractMono16k(
    buffer,
    clip.sourceInMs / 1000,
    (clip.sourceOutMs - clip.sourceInMs) / 1000,
  );
  if (signal?.aborted) return null;

  const w = ensureWorker();
  return new Promise<SubtitleCue[] | null>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = (e: MessageEvent<CaptionReply>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress({ stage: m.stage, value: m.value });
      else if (m.type === 'result') {
        cleanup();
        resolve(segmentsToCues(m.segments, clip));
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message));
      }
    };
    const onAbort = () => {
      cleanup();
      // A transcription in flight cannot be cancelled cooperatively; drop the
      // worker so it stops, and the next run spins a fresh one (model still cached).
      w.terminate();
      worker = null;
      resolve(null);
    };
    w.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort);
    const req: CaptionRequest = { type: 'transcribe', audio, language: opts.language };
    w.postMessage(req, [audio.buffer]);
  });
}
