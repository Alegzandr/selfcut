import { describe, expect, it } from 'vitest';
import {
  bestDefaultModel,
  captionFit,
  captionModelSizeMb,
  captionsSupported,
  type CaptionCapabilities,
} from './captionsCapabilities';
import { CAPTION_MODELS, captionModel } from './captionsModel';

const gpu: CaptionCapabilities = {
  device: 'webgpu',
  memoryGb: 16,
  maxBufferBytes: 2 ** 31,
  f16: true,
  handheld: false,
};
const cpu: CaptionCapabilities = { device: 'wasm', memoryGb: 8, f16: false, handheld: false };
/** A WebGPU adapter without the optional fp16 feature - drivers like it exist. */
const gpuNoF16: CaptionCapabilities = { ...gpu, f16: false };
/** Safari and Firefox expose no `deviceMemory` at all, on any hardware. */
const gpuNoMemory: CaptionCapabilities = { ...gpu, memoryGb: undefined };
/** A phone with a working WebGPU adapter. */
const phone: CaptionCapabilities = { ...gpu, memoryGb: undefined, handheld: true };
const phoneNoGpu: CaptionCapabilities = { device: 'wasm', f16: false, handheld: true };

describe('captionFit', () => {
  it('rules out the GPU-only model on a machine with no GPU', () => {
    // Offering it there would sell a multi-gigabyte download that then
    // transcribes slower than the footage plays.
    expect(captionFit(captionModel('large-v3-turbo'), cpu)).toBe('unsupported');
  });

  it('warns rather than forbids on the heavy models without a GPU', () => {
    expect(captionFit(captionModel('small'), cpu)).toBe('slow');
    expect(captionFit(captionModel('base'), cpu)).toBe('recommended');
  });

  it('recommends the accurate models once a GPU is there', () => {
    expect(captionFit(captionModel('large-v3-turbo'), gpu)).toBe('recommended');
    expect(captionFit(captionModel('small'), gpu)).toBe('recommended');
  });

  it('backs off the biggest model on a GPU machine short on memory', () => {
    expect(captionFit(captionModel('large-v3-turbo'), { ...gpu, memoryGb: 4 })).toBe('slow');
  });

  it('offers the fp16 model without recommending it on an adapter with no fp16', () => {
    // It runs, on the q8 fallback: the row must not be ruled out, and must not
    // carry the badge that says this is the configuration we measured.
    expect(captionFit(captionModel('large-v3-turbo'), gpuNoF16)).toBe('usable');
  });

  it('leaves the fp32 models alone when the adapter has no fp16', () => {
    expect(captionFit(captionModel('small'), gpuNoF16)).toBe('recommended');
  });

  it('neither promises nor condemns the biggest model when RAM is unreported', () => {
    // The Safari/Firefox case: no deviceMemory on any hardware, including the
    // Apple Silicon machines this model is best on.
    expect(captionFit(captionModel('large-v3-turbo'), gpuNoMemory)).toBe('usable');
  });

  it('rules the heavy models out on a phone rather than merely warning', () => {
    // They have no handheld profile, and offering them anyway is what put an
    // fp32 download in front of a browser that dies holding it.
    expect(captionFit(captionModel('large-v3-turbo'), phone)).toBe('unsupported');
    expect(captionFit(captionModel('small'), phone)).toBe('unsupported');
    expect(captionFit(captionModel('base'), phone)).toBe('recommended');
    expect(captionFit(captionModel('tiny'), phone)).toBe('usable');
  });

  it('rules out every model on a phone whose adapter has no fp16', () => {
    // The handheld weights only exist as fp16 in these repos: there is no
    // slower path to fall back to, so the honest answer is none.
    const noF16 = { ...phone, f16: false };
    for (const model of CAPTION_MODELS)
      expect(captionFit(model, noF16)).toBe('unsupported');
  });

  it('rules out a model an adapter cannot allocate', () => {
    const tinyBuffers: CaptionCapabilities = { ...gpu, maxBufferBytes: 16 * 1024 * 1024 };
    expect(captionFit(captionModel('large-v3-turbo'), tinyBuffers)).toBe('unsupported');
  });
});

describe('captionModelSizeMb', () => {
  it('quotes the handheld download on a phone and the fp32 one elsewhere', () => {
    // The same model is not the same download twice, and the picker must not
    // print the desktop figure to someone about to spend the phone one.
    const base = captionModel('base');
    expect(captionModelSizeMb(base, phone)).toBe(base.handheld!.sizeMb);
    expect(captionModelSizeMb(base, gpu)).toBe(base.sizeMb.webgpu);
    expect(captionModelSizeMb(base, cpu)).toBe(base.sizeMb.wasm);
  });
});

describe('captionsSupported', () => {
  it('offers captions on a phone with a GPU', () => {
    expect(captionsSupported(phone)).toBe(true);
  });

  it('declines the CPU path on a handheld, where it means an hour of full tilt', () => {
    expect(captionsSupported(phoneNoGpu)).toBe(false);
  });

  it('declines a handheld GPU that cannot load any model', () => {
    expect(captionsSupported({ ...phone, f16: false })).toBe(false);
  });

  it('keeps the CPU fallback on a desktop, as it always was', () => {
    expect(captionsSupported(cpu)).toBe(true);
    expect(captionsSupported(gpu)).toBe(true);
  });
});

describe('bestDefaultModel', () => {
  it('preselects the most accurate model the machine handles', () => {
    expect(bestDefaultModel(gpu)).toBe('large-v3-turbo');
    expect(bestDefaultModel(cpu)).toBe('base');
    // No fp16: the turbo row is usable, not recommended, so the preselection
    // steps down to the best model this adapter runs at full precision.
    expect(bestDefaultModel(gpuNoF16)).toBe('small');
    // A phone preselects the model it can actually fetch and hold.
    expect(bestDefaultModel(phone)).toBe('base');
  });

  it('never preselects a model it just called unsupported', () => {
    const all = [gpu, gpuNoF16, gpuNoMemory, phone, phoneNoGpu, cpu];
    for (const caps of all) {
      const picked = CAPTION_MODELS.find((m) => m.id === bestDefaultModel(caps))!;
      expect(captionFit(picked, caps)).not.toBe('unsupported');
    }
  });
});
