import { describe, expect, it } from 'vitest';
import {
  bestDefaultModel,
  captionFit,
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

  it('keeps the heavy models off a phone without ruling them out', () => {
    expect(captionFit(captionModel('large-v3-turbo'), phone)).toBe('slow');
    expect(captionFit(captionModel('small'), phone)).toBe('usable');
    expect(captionFit(captionModel('base'), phone)).toBe('recommended');
  });

  it('rules out a model an adapter cannot allocate', () => {
    const tinyBuffers: CaptionCapabilities = { ...gpu, maxBufferBytes: 16 * 1024 * 1024 };
    expect(captionFit(captionModel('large-v3-turbo'), tinyBuffers)).toBe('unsupported');
  });
});

describe('captionsSupported', () => {
  it('offers captions on a phone with a GPU', () => {
    expect(captionsSupported(phone)).toBe(true);
  });

  it('declines the CPU path on a handheld, where it means an hour of full tilt', () => {
    expect(captionsSupported(phoneNoGpu)).toBe(false);
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
