/**
 * What to do about a caught error, decided from its message alone.
 *
 * Split out from the handler that installs itself on `window` so the policy can
 * be tested for what it is - a set of rules about strings - without dragging in
 * the store, i18n and the whole media stack behind them.
 */

/** What a caught error should turn into. */
export type ErrorAction =
  /** Tell the user, with a reload suggestion: the app is likely broken now. */
  | 'reload'
  /** Tell the user once; the session can continue. */
  | 'notify'
  /** Console only: nothing the user can act on. */
  | 'log';

/**
 * A dynamic import that fails after a redeploy: the HTML in the tab points at
 * chunk hashes the server no longer has. It looks like a crash and is fixed by
 * a reload, so it is worth saying so rather than showing a generic failure.
 */
const CHUNK_LOAD =
  /(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError)/i;

/**
 * Cross-origin scripts report as the literal string "Script error." with no
 * file, line or stack. Nothing there is actionable and it is almost always a
 * browser extension injected into the page, so it never reaches the user.
 */
const OPAQUE = /^script error\.?$/i;

export function classifyError(message: string): ErrorAction {
  if (!message || OPAQUE.test(message.trim())) return 'log';
  if (CHUNK_LOAD.test(message)) return 'reload';
  return 'notify';
}

/**
 * The signature two reports are considered "the same problem" by. The message
 * alone: a decode that fails on every frame produces the same text sixty times
 * a second, and the user needs to be told exactly once.
 */
export function errorSignature(message: string): string {
  return message.slice(0, 200);
}

/** Best-effort message for anything that can be thrown or rejected with. */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const m = (value as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(value);
}
