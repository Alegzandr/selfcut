import { describe, expect, it } from 'vitest';
import { nextAttempt, retryReason, type ExportAttempt } from './retryPlan';

const FIRST: ExportAttempt = { noParallel: false, preferSoftware: false };

describe('nextAttempt', () => {
  it('walks a stalled encoder from fanned-out to one encoder to software', () => {
    const serial = nextAttempt(FIRST, 'encoderStalled');
    expect(serial).toEqual({ noParallel: true, preferSoftware: false });
    const software = nextAttempt(serial!, 'encoderStalled');
    expect(software).toEqual({ noParallel: true, preferSoftware: true });
    // Nothing gentler left to ask for: the failure is the user's to see.
    expect(nextAttempt(software!, 'encoderStalled')).toBeNull();
  });

  it('keeps the render on hardware for its first fallback', () => {
    // The point of the middle step: two encoder sessions is what a GPU refuses
    // to sustain far more often than the geometry is, and dropping to software
    // straight away would cost every such export several times its own runtime.
    expect(nextAttempt(FIRST, 'encoderStalled')?.preferSoftware).toBe(false);
  });

  it('sends a segment mismatch serial, and no further', () => {
    const serial = nextAttempt(FIRST, 'segmentMismatch');
    expect(serial).toEqual({ noParallel: true, preferSoftware: false });
    // A different encoder does not make two encoders agree; there is only ever
    // one answer to a mismatch, and it has been given.
    expect(nextAttempt(serial!, 'segmentMismatch')).toBeNull();
  });

  it('still has the software fallback left after a mismatch went serial', () => {
    const serial = nextAttempt(FIRST, 'segmentMismatch')!;
    expect(nextAttempt(serial, 'encoderStalled')).toEqual({
      noParallel: true,
      preferSoftware: true,
    });
  });

  it('does not re-run failures that are about the project or the browser', () => {
    expect(nextAttempt(FIRST, 'noAudibleAudio')).toBeNull();
    expect(nextAttempt(FIRST, 'videoEncoderUnsupported')).toBeNull();
  });

  it('never loosens a term, so the escalation terminates', () => {
    // Every retry is strictly harder-working than the one before, which is what
    // bounds this at two renders rather than a loop the user cannot leave.
    const codes = ['encoderStalled', 'segmentMismatch'] as const;
    for (const first of codes) {
      for (const second of codes) {
        let current: ExportAttempt | null = FIRST;
        const seen: ExportAttempt[] = [];
        for (const code of [first, second, first, second, first]) {
          const next: ExportAttempt | null = nextAttempt(current, code);
          if (!next) break;
          expect(next.noParallel >= current.noParallel).toBe(true);
          expect(next.preferSoftware >= current.preferSoftware).toBe(true);
          seen.push(next);
          current = next;
        }
        expect(seen.length).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('retryReason', () => {
  it('names the encoder the render is falling back to', () => {
    expect(retryReason('encoderStalled', { noParallel: true, preferSoftware: false })).toMatch(
      /one encoder/,
    );
    expect(retryReason('encoderStalled', { noParallel: true, preferSoftware: true })).toMatch(
      /software/,
    );
  });
});
