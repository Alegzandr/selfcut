/**
 * The net under everything that is not inside a React render.
 *
 * An `ErrorBoundary` only catches what throws during render, commit or effects.
 * It never sees a rejected promise from a decode, a throw inside a rAF tick, a
 * failed dynamic import, or an error raised by a worker's own onerror. Those
 * used to end at the console - which no user reads - so the editor would fail
 * silently and the person at the keyboard would only learn about it from the
 * result, or from nothing at all.
 *
 * The policy is deliberately conservative: say something ONCE per distinct
 * problem, keep it out of the way, and never let the reporter itself become a
 * source of errors or of noise.
 */
import { useStore } from '../store/store';
import { t } from '../i18n';
import { classifyError, errorSignature, messageOf } from './errorPolicy';

/** Distinct problems reported to the user before the reporter goes quiet. */
const MAX_DISTINCT_REPORTS = 3;

const seen = new Set<string>();
let reported = 0;
/** Guards against an error thrown while reporting an error. */
let inside = false;

function report(source: string, value: unknown): void {
  if (inside) return;
  inside = true;
  try {
    const message = messageOf(value);
    console.error(`[${source}]`, value);
    const action = classifyError(message);
    if (action === 'log') return;
    const key = errorSignature(message);
    if (seen.has(key)) return;
    seen.add(key);
    if (reported >= MAX_DISTINCT_REPORTS) return;
    reported++;
    useStore
      .getState()
      .setError(
        action === 'reload' ? t('errors.app.staleBuild') : t('errors.app.unexpected', { detail: message.slice(0, 160) }),
      );
  } catch {
    /* the reporter must never be the thing that breaks the app */
  } finally {
    inside = false;
  }
}

let installed = false;

/**
 * Install the handlers. Idempotent, so a hot reload does not stack them.
 * Returns a teardown for tests.
 */
export function installGlobalErrorHandlers(): () => void {
  if (installed) return () => {};
  installed = true;

  const onError = (event: ErrorEvent): void => {
    // A failed subresource (an <img>, a <link>) also fires `error` on window in
    // the capture phase. It carries no message and nothing to act on.
    if (event.target && event.target !== window) return;
    report('window.error', event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    report('unhandledrejection', event.reason);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}

/** Test seam: forget what has already been reported. */
export function resetErrorReporting(): void {
  seen.clear();
  reported = 0;
}

/**
 * Report an error caught by code that has its own try/catch but no way to reach
 * the user - a worker's onerror, a failed background task. Same de-duplication.
 */
export function reportCaughtError(source: string, value: unknown): void {
  report(source, value);
}
