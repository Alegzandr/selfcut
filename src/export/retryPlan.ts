import type { ExportErrorCode } from './protocol';

/**
 * What to try next when a render comes back with a failure that has an answer.
 *
 * Pure, and separate from the exporter, for the same reason `segmentPlan` and
 * `encoderSetup` are: it is a short piece of reasoning about which failures are
 * worth another render, and it can be stated and tested without a worker, an
 * encoder or a file handle in the way.
 */

/** The terms one attempt at a render runs on. */
export interface ExportAttempt {
  /** Render on one worker instead of fanning out: one encoder session, not two. */
  noParallel: boolean;
  /** Ask for the software encoder rather than letting the browser choose. */
  preferSoftware: boolean;
}

/**
 * The next attempt to make, or null when the failure has to reach the user.
 *
 * Every step tightens exactly one term and never loosens either, so there are
 * at most two retries and the escalation cannot loop.
 *
 * A STALLED ENCODER escalates in two steps rather than jumping to the software
 * one, because the two things that stop an encoder are not the same thing. A
 * fanned-out render holds one hardware encoder session PER WORKER, and a GPU
 * that is happy with one 1440p60 session can accept a second and then deliver
 * nothing from either - so the first answer is one encoder instead of two,
 * which keeps the render on hardware and costs it nothing but the fan-out.
 * Only when a single encoder stalls too is the configuration itself past what
 * this machine can sustain, and the software encoder - several times slower,
 * and it finishes - is what is left.
 *
 * A SEGMENT MISMATCH has only ever had one answer: two identically configured
 * encoders produced different parameter sets, so their slices cannot be
 * concatenated, and the render has to be done by one encoder. Nothing about
 * that is helped by asking for a different encoder, so it does not escalate
 * past serial.
 *
 * Every other code is a statement about the project or the browser rather than
 * about how hard the render was asked to work, and re-running it would produce
 * the same failure more slowly.
 */
export function nextAttempt(current: ExportAttempt, code: ExportErrorCode): ExportAttempt | null {
  if (code === 'segmentMismatch') {
    return current.noParallel ? null : { ...current, noParallel: true };
  }
  if (code === 'encoderStalled') {
    if (!current.noParallel) return { ...current, noParallel: true };
    if (!current.preferSoftware) return { ...current, preferSoftware: true };
    return null;
  }
  return null;
}

/** Why the render is starting over, for the console of whoever reports the bug. */
export function retryReason(code: ExportErrorCode, next: ExportAttempt): string {
  if (code === 'segmentMismatch') return 'segment encoders disagreed, re-rendering serially';
  return next.preferSoftware
    ? 'encoder stopped responding, re-rendering on the software encoder'
    : 'encoder stopped responding, re-rendering on one encoder';
}
