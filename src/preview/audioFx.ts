import { AudioFx } from '../types';

/**
 * Per-clip audio effects as native Web Audio nodes. `buildAudioFxChain` returns
 * a sub-graph with one `input` and one `output`, which `scheduleClip` splices
 * between the clip's gain/pan tail and the mix destination. Because
 * `scheduleProjectAudio` is shared by the preview (`AudioContext`) and the
 * export (`OfflineAudioContext`), an effect built here renders identically in
 * both — the same "one code path" the rest of the mix relies on.
 *
 * Every effect is a native node (compressor, biquad, convolver, delay), so
 * nothing is bundled and nothing is heavier than the browser's own DSP.
 */

/** One built effect: its entry node, its exit node, and every node to disconnect. */
interface Segment {
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
}

/**
 * A short synthetic reverb impulse response (decaying stereo noise), memoized per
 * audio context so every reverb clip shares one buffer. Avoids bundling an IR
 * file: a 1.6 s exponential-decay noise burst is a serviceable room.
 */
const reverbIRCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function reverbImpulse(ctx: BaseAudioContext): AudioBuffer {
  const cached = reverbIRCache.get(ctx);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * 1.6);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const decay = Math.pow(1 - i / len, 2.5);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  reverbIRCache.set(ctx, ir);
  return ir;
}

/**
 * Mix an effect's wet path back against the dry signal. `dryLevel` is 1 for
 * additive effects (reverb, echo — the source stays, the effect sits on top) and
 * `1 - wet` for effects that replace the tone.
 */
function wetDry(
  ctx: BaseAudioContext,
  effIn: AudioNode,
  effOut: AudioNode,
  inner: AudioNode[],
  wet: number,
  dryLevel: number,
): Segment {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wetGain = ctx.createGain();
  dry.gain.value = dryLevel;
  wetGain.gain.value = wet;
  input.connect(dry);
  dry.connect(output);
  input.connect(effIn);
  effOut.connect(wetGain);
  wetGain.connect(output);
  return { input, output, nodes: [input, output, dry, wetGain, ...inner] };
}

function buildSegment(ctx: BaseAudioContext, fx: AudioFx): Segment | null {
  const amount = Math.max(0, Math.min(1, fx.amount));
  if (amount <= 0) return null;
  switch (fx.type) {
    case 'leveler': {
      // Compress harder with intensity, then make up the lost level so the clip
      // sounds louder and steadier rather than just quieter.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14 - amount * 26;
      comp.ratio.value = 2 + amount * 8;
      comp.knee.value = 30;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
      const makeup = ctx.createGain();
      makeup.gain.value = 1 + amount * 0.7;
      comp.connect(makeup);
      return { input: comp, output: makeup, nodes: [comp, makeup] };
    }
    case 'voice': {
      // Cut rumble, lift presence — the classic talking-head cleanup.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 90;
      hp.Q.value = 0.7;
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 3000;
      presence.Q.value = 0.9;
      presence.gain.value = amount * 6;
      hp.connect(presence);
      return { input: hp, output: presence, nodes: [hp, presence] };
    }
    case 'bass': {
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'lowshelf';
      shelf.frequency.value = 140;
      shelf.gain.value = amount * 10;
      return { input: shelf, output: shelf, nodes: [shelf] };
    }
    case 'reverb': {
      const conv = ctx.createConvolver();
      conv.buffer = reverbImpulse(ctx);
      return wetDry(ctx, conv, conv, [conv], amount * 0.9, 1);
    }
    case 'echo': {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.3;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.15 + amount * 0.45;
      delay.connect(feedback);
      feedback.connect(delay);
      return wetDry(ctx, delay, delay, [delay, feedback], amount * 0.8, 1);
    }
  }
}

/**
 * Build the clip's effects into one series chain, or null when it has none. The
 * segments connect output→input in order; the caller wires `input` after the
 * clip's gain/pan and `output` into the destination, and disconnects `nodes` on
 * stop along with the rest of the clip chain.
 */
export function buildAudioFxChain(
  ctx: BaseAudioContext,
  fx: AudioFx[] | undefined,
): Segment | null {
  if (!fx || fx.length === 0) return null;
  const segments: Segment[] = [];
  for (const one of fx) {
    const seg = buildSegment(ctx, one);
    if (seg) segments.push(seg);
  }
  if (segments.length === 0) return null;
  for (let i = 1; i < segments.length; i++) {
    segments[i - 1]!.output.connect(segments[i]!.input);
  }
  return {
    input: segments[0]!.input,
    output: segments[segments.length - 1]!.output,
    nodes: segments.flatMap((s) => s.nodes),
  };
}
