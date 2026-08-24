import { describe, expect, it } from 'vitest';
import {
  canFanOut,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_WORKERS,
  MIN_SEGMENT_SECONDS,
  planSegments,
} from './segmentPlan';

/** Encoded bytes one slice of `frames` holds, at the bitrate the preset asks for. */
function segmentBytes(frames: number, fps: number, videoBitrate: number): number {
  return (frames / fps) * (videoBitrate / 8);
}

/**
 * The size a slice may actually reach, which is the byte cap OR the minimum
 * length, whichever is larger - the planner applies them with `Math.max`, so
 * the floor overrides the cap rather than the other way round.
 *
 * The two very nearly meet at 4K 120: four seconds of 134.4 Mbps is 67.20 MB
 * against a 64 MiB (67.11 MB) ceiling, so the floor wins there by 0.14%. That
 * near-coincidence is what makes the cap meaningful at the heaviest rung
 * instead of unreachable, and asserting the raw cap would fail on that 0.14%
 * while saying nothing about the four-fold overshoot this file guards against.
 */
function ceilingFor(preset: { fps: number; videoBitrate: number }): number {
  const floorBytes = segmentBytes(
    Math.ceil(MIN_SEGMENT_SECONDS * preset.fps),
    preset.fps,
    preset.videoBitrate,
  );
  return Math.max(MAX_SEGMENT_BYTES, floorBytes);
}

/** The "120 fps · 4K" preset: 60 Mbps base, x1.4 at the 4K rung, x1.6 past 90 fps. */
const FOUR_K_120 = { fps: 120, videoBitrate: 134_400_000 };
const SEVEN_TWENTY_60 = { fps: 60, videoBitrate: 7_500_000 };
const TEN_EIGHTY_60 = { fps: 60, videoBitrate: 24_000_000 };

describe('planSegments', () => {
  it('covers the render exactly, in order, with no gap and no overlap', () => {
    const totalFrames = 23_555;
    const { segments } = planSegments({ totalFrames, ...FOUR_K_120, cores: 16 });
    let cursor = 0;
    for (const s of segments) {
      expect(s.firstFrame).toBe(cursor);
      expect(s.frameCount).toBeGreaterThan(0);
      cursor += s.frameCount;
    }
    expect(cursor).toBe(totalFrames);
  });

  it('renders serially when there is no second core to render on', () => {
    const plan = planSegments({ totalFrames: 100_000, ...FOUR_K_120, cores: 2 });
    expect(plan.workers).toBe(1);
    expect(plan.segments).toHaveLength(1);
  });

  it('renders serially when the render is too short to hold two slices', () => {
    const totalFrames = MIN_SEGMENT_SECONDS * 60 * 2 - 1;
    const plan = planSegments({ totalFrames, ...TEN_EIGHTY_60, cores: 16 });
    expect(plan.workers).toBe(1);
    expect(plan.segments).toHaveLength(1);
  });

  it('never runs more workers than the encoder is worth sharing between', () => {
    const plan = planSegments({ totalFrames: 23_555, ...FOUR_K_120, cores: 32 });
    expect(plan.workers).toBeLessThanOrEqual(MAX_SEGMENT_WORKERS);
  });

  /**
   * The regression this file exists for.
   *
   * A slice is buffered whole in its worker and handed to the lead whole, so
   * MAX_SEGMENT_BYTES is the only thing standing between a long 4K render and
   * gigabytes of encoded video held at once. It is applied as
   * `Math.max(minFrames, byBytes)`, which means the minimum-length floor wins
   * outright whenever the two disagree - and at 4K they always disagree. With
   * the floor at fifteen seconds the cap was dead code at exactly the geometry
   * whose name is in its own comment: slices came out at 252 MB against a 64 MB
   * ceiling, and a fourteen-slice render could hold several GB.
   */
  it('honours the byte ceiling at 4K 120, where a slice is heaviest', () => {
    const { segments } = planSegments({ totalFrames: 23_555, ...FOUR_K_120, cores: 16 });
    const cap = ceilingFor(FOUR_K_120);
    for (const s of segments) {
      expect(segmentBytes(s.frameCount, FOUR_K_120.fps, FOUR_K_120.videoBitrate)).toBeLessThanOrEqual(cap);
    }
    // Sharper than the bound above, and the part that would have failed before:
    // the cap is what decides the slice length here, so the slices land ON it
    // rather than merely under some multiple of it. At fifteen seconds they came
    // out at 252 MB, near four times the ceiling.
    const heaviest = Math.max(
      ...segments.map((s) => segmentBytes(s.frameCount, FOUR_K_120.fps, FOUR_K_120.videoBitrate)),
    );
    expect(heaviest).toBeGreaterThan(MAX_SEGMENT_BYTES * 0.5);
    expect(heaviest).toBeLessThan(MAX_SEGMENT_BYTES * 1.05);
  });

  it('honours the byte ceiling at every rung a preset offers', () => {
    for (const preset of [FOUR_K_120, TEN_EIGHTY_60, SEVEN_TWENTY_60]) {
      for (const seconds of [40, 90, 196, 600]) {
        const totalFrames = Math.ceil(seconds * preset.fps);
        const { segments } = planSegments({ totalFrames, ...preset, cores: 16 });
        // A serial plan is one slice by definition and is bounded by the render,
        // not by this cap.
        if (segments.length < 2) continue;
        for (const s of segments) {
          expect(segmentBytes(s.frameCount, preset.fps, preset.videoBitrate)).toBeLessThanOrEqual(
            ceilingFor(preset),
          );
        }
      }
    }
  });

  /**
   * The other side of the same trade. Slicing is not free - each one pays an
   * encoder configuration and a seek into every clip it touches - so a render
   * light enough to stay under the byte cap must not be chopped up for nothing.
   */
  it('leaves a light render in long slices', () => {
    const { segments } = planSegments({ totalFrames: 196 * 60, ...SEVEN_TWENTY_60, cores: 16 });
    for (const s of segments) {
      expect(s.frameCount / SEVEN_TWENTY_60.fps).toBeGreaterThan(MIN_SEGMENT_SECONDS * 2);
    }
  });

  it('gives every slice at least the minimum length it plans for', () => {
    const { segments } = planSegments({ totalFrames: 196 * 120, ...FOUR_K_120, cores: 16 });
    const minFrames = Math.ceil(MIN_SEGMENT_SECONDS * FOUR_K_120.fps);
    for (const s of segments) expect(s.frameCount).toBeGreaterThanOrEqual(minFrames);
  });
});

/**
 * Geometry from the real preset table (`TIERS` and the smooth120 family in
 * `presets.ts`), not invented: the gate is only meaningful if the presets the
 * app actually ships fall on the side of it they are supposed to.
 */
describe('canFanOut', () => {
  it('refuses the geometry that killed the media process', () => {
    // 4K 120, landscape and vertical alike: ~995 Mpx/s, two sessions of it at
    // once. The export a tester lost at 22%, with two slice-worker crashes 22 s
    // apart and a GPU crash count still at zero.
    expect(canFanOut({ width: 3840, height: 2160, fps: 120 })).toBe(false);
    expect(canFanOut({ width: 2160, height: 3840, fps: 120 })).toBe(false);
  });

  it('still fans out everything below it', () => {
    // The heaviest rungs that stay parallel, and the ordinary ones.
    expect(canFanOut({ width: 3840, height: 2160, fps: 60 })).toBe(true); // 497 Mpx/s
    expect(canFanOut({ width: 2560, height: 1440, fps: 120 })).toBe(true); // 442 Mpx/s
    expect(canFanOut({ width: 1920, height: 1080, fps: 120 })).toBe(true); // 249 Mpx/s
    expect(canFanOut({ width: 1920, height: 1080, fps: 60 })).toBe(true); // 124 Mpx/s
    expect(canFanOut({ width: 1280, height: 720, fps: 60 })).toBe(true); //  55 Mpx/s
  });

  it('reads the same either way up', () => {
    // Vertical is the app's default aspect ratio and mirrors the pixel count of
    // its landscape rung, so the gate must not depend on which side is longer.
    expect(canFanOut({ width: 1440, height: 2560, fps: 120 })).toBe(
      canFanOut({ width: 2560, height: 1440, fps: 120 }),
    );
  });
});
