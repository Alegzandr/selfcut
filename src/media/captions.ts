import { Clip, MediaAsset } from "../types";
import type { SubtitleCue } from "../lib/subtitles";
import { clipDurationMs, clipEndMs } from "../model";
import { getAudioBuffer } from "./mediaCache";
import type {
  CaptionReply,
  CaptionRequest,
  CaptionSegment,
} from "./captionsProtocol";

/**
 * Local auto-captions (desktop only): transcribe a clip's audio with Whisper (in
 * a worker) and turn the result into subtitle cues, ready for `addSubtitleClips`.
 * The audio is decoded, downmixed and resampled to mono 16 kHz here and
 * transferred to the worker - nothing leaves the browser.
 */

export interface CaptionProgress {
  /** 'model' while the weights download (first run), 'transcribe' while running. */
  stage: "model" | "transcribe";
  /** 0..1 for the model download; 1 (indeterminate) while transcribing. */
  value: number;
  /** Which clip of a multi-clip run this is, 1-based. Absent on a single clip. */
  clip?: { index: number; total: number };
}

export interface CaptionOptions {
  /** Model id from the catalogue (`captionsModel`). */
  model: string;
  /** Whisper language code ('en', 'fr'...); omit to let Whisper detect it. */
  language?: string;
  /**
   * Run the speech chain (high-pass, compression, levelling) before Whisper
   * sees the audio. Default on; see `extractMono16k`.
   */
  enhanceVoice?: boolean;
  /**
   * Which audio track of the source to listen to, overriding the one the clip
   * plays. A dubbed export carries the original and the dub side by side, and
   * the captions wanted are not always the ones being monitored.
   */
  audioTrackIndex?: number;
}

let worker: Worker | null = null;
function newWorker(): Worker {
  return new Worker(new URL("./captionsWorker.ts", import.meta.url), {
    type: "module",
  });
}
function ensureWorker(): Worker {
  worker ??= newWorker();
  return worker;
}

/**
 * Loudness Whisper was trained on. Speech corpora sit around -20 dBFS RMS, and
 * a transcript degrades noticeably on a track recorded far below that.
 */
const TARGET_RMS = 0.1;

/**
 * Bring a mono speech buffer to a predictable level, in place.
 *
 * Aims at an RMS target rather than at the peak, because peak normalisation is
 * hostage to a single stray transient - one door slam and the voice underneath
 * stays as quiet as it was. The peak still acts as a ceiling (no clipping), and
 * the boost is capped so a near-silent take is not turned into amplified room
 * noise that Whisper then hallucinates words out of.
 */
export function normalizeSpeech(samples: Float32Array): Float32Array {
  let peak = 0;
  let sum = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  if (peak === 0) return samples;
  const rms = Math.sqrt(sum / samples.length);
  const gain = Math.min(TARGET_RMS / (rms || 1e-9), 0.97 / peak, 12);
  if (Math.abs(gain - 1) < 0.01) return samples;
  for (let i = 0; i < samples.length; i++) samples[i]! *= gain;
  return samples;
}

/**
 * Whisper wants mono 16 kHz: render the clip's source span through an offline
 * context, which resamples and downmixes to one channel in one pass.
 *
 * With `enhance`, the render also runs the speech chain. Stream footage is the
 * case this is for: the voice shares its track with music, game audio and alert
 * sounds, and Whisper does measurably worse on a quiet voice buried under a
 * loud bed than on the same voice brought forward.
 *  - high-pass at 80 Hz: rumble, desk thumps and mains hum carry no speech, but
 *    they do eat headroom that the levelling below would otherwise hand them;
 *  - compression: a gentle 4:1 closes the gap between a shouted reaction and a
 *    mumbled aside, so one pass of levelling suits the whole clip;
 *  - normalisation: see `normalizeSpeech`.
 *
 * Deliberately NOT here: source separation (a second model download, and it
 * costs more than it gains once the voice is levelled) and noise gating (it
 * clips word onsets, and a swallowed first syllable is worse than a noisy one).
 */
async function extractMono16k(
  buffer: AudioBuffer,
  startSec: number,
  durationSec: number,
  enhance: boolean,
): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil(durationSec * 16000));
  const ctx = new OfflineAudioContext(1, frames, 16000);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  if (enhance) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 80;
    hp.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    src.connect(hp).connect(comp).connect(ctx.destination);
  } else {
    src.connect(ctx.destination);
  }
  src.start(0, Math.max(0, startSec), durationSec);
  const rendered = await ctx.startRendering();
  const mono = rendered.getChannelData(0).slice();
  return enhance ? normalizeSpeech(mono) : mono;
}

/**
 * Map Whisper segments (seconds, audio-relative) to timeline cues for `clip`,
 * accounting for its speed and clamping to its span. A segment with no end time
 * borrows the next one's start (or a short default on the last).
 */
export function segmentsToCues(
  segments: CaptionSegment[],
  clip: Clip,
): SubtitleCue[] {
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
 * has no real duration). Cancelling terminates the worker so the transcription
 * stops - the model stays in the browser cache, so the next run only pays for
 * the load.
 */
export async function generateCaptions(
  clip: Clip,
  asset: MediaAsset,
  opts: CaptionOptions,
  onProgress: (p: CaptionProgress) => void,
  signal?: AbortSignal,
): Promise<SubtitleCue[] | null> {
  if (!asset.hasAudio || clipDurationMs(clip) <= 0) return null;
  const trackIndex = opts.audioTrackIndex ?? clip.audioTrackIndex;
  const buffer = await getAudioBuffer(asset, trackIndex);
  if (!buffer || signal?.aborted) return null;

  const audio = await extractMono16k(
    buffer,
    clip.sourceInMs / 1000,
    (clip.sourceOutMs - clip.sourceInMs) / 1000,
    opts.enhanceVoice !== false,
  );
  if (signal?.aborted) return null;

  const w = ensureWorker();
  return new Promise<SubtitleCue[] | null>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    };
    const onMessage = (e: MessageEvent<CaptionReply>) => {
      const m = e.data;
      if (m.type === "progress") onProgress({ stage: m.stage, value: m.value });
      else if (m.type === "result") {
        cleanup();
        resolve(segmentsToCues(m.segments, clip));
      } else if (m.type === "error") {
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
    w.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort);
    const req: CaptionRequest = {
      type: "transcribe",
      audio,
      model: opts.model,
      language: opts.language,
    };
    w.postMessage(req, [audio.buffer]);
  });
}

/**
 * Transcribe several clips in one pass and return their cues in timeline order,
 * so a whole selection lands as ONE caption track instead of one per clip.
 *
 * Sequential on purpose: two Whisper runs at once share the same GPU and the
 * same memory ceiling, and finish later than the same two run one after the
 * other. A clip that fails does not sink the batch - the rest still lands, and
 * only a run where every clip failed is reported as a failure.
 */
export async function generateCaptionsForClips(
  clips: Array<{ clip: Clip; asset: MediaAsset }>,
  opts: CaptionOptions,
  onProgress: (p: CaptionProgress) => void,
  signal?: AbortSignal,
): Promise<SubtitleCue[] | null> {
  const all: SubtitleCue[] = [];
  let failures = 0;
  for (const [i, { clip, asset }] of clips.entries()) {
    if (signal?.aborted) break;
    const at = { index: i + 1, total: clips.length };
    try {
      const cues = await generateCaptions(
        clip,
        asset,
        opts,
        (p) => onProgress(clips.length > 1 ? { ...p, clip: at } : p),
        signal,
      );
      if (cues) all.push(...cues);
    } catch (err) {
      failures++;
      console.warn("[captions] clip failed:", err);
    }
  }
  if (failures > 0 && failures === clips.length)
    throw new Error("every clip failed to transcribe");
  if (signal?.aborted) return null;
  return all.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Download a model's weights without transcribing anything, for the model
 * manager. Runs in its own throwaway worker: the loaded pipeline is not what is
 * wanted here (the browser cache is), and terminating it hands the memory back
 * instead of holding a model nobody asked to run.
 */
export function prefetchCaptionModel(
  model: string,
  onProgress: (value: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const w = newWorker();
  return new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => {
      w.terminate();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => done(resolve);
    w.addEventListener("message", (e: MessageEvent<CaptionReply>) => {
      const m = e.data;
      if (m.type === "progress" && m.stage === "model") onProgress(m.value);
      else if (m.type === "ready") done(resolve);
      else if (m.type === "error") done(() => reject(new Error(m.message)));
    });
    signal?.addEventListener("abort", onAbort);
    const req: CaptionRequest = { type: "prefetch", model };
    w.postMessage(req);
  });
}
