/**
 * The fonts a text clip can render in.
 *
 * Self-hosted woff2 (latin subset) rather than fonts.gstatic.com: the build
 * ships a `default-src 'self'` CSP, and an export has to render identically
 * with no network. Faces load on demand, so a project that stays on the default
 * downloads nothing beyond the face the UI already uses.
 *
 * The preview (main thread) and the export worker share `drawClip`, so BOTH
 * globals have to register the face before measuring or filling text: a canvas
 * silently falls back to its default font otherwise, and the export would not
 * match what the user validated in the preview. Each bundle keeps its own
 * module instance, which is why loading is per-global and idempotent.
 */
export type FontId = 'archivo' | 'inter' | 'anton' | 'bebas' | 'playfair' | 'caveat';

export const DEFAULT_FONT_ID: FontId = 'archivo';

export interface FontDef {
  id: FontId;
  /** CSS family name - what `ctx.font` resolves against. */
  family: string;
  file: string;
  /** FontFace `weight` descriptor: a range for variable faces, one value otherwise. */
  weight: string;
  /** Single-weight face: a bold request can only ever be synthesised. */
  singleWeight?: boolean;
}

/**
 * One face per intention, no two overlapping: a neutral default, a plain
 * workhorse, a condensed impact face, condensed caps for titles, a serif for
 * contrast and a handwritten one.
 */
export const FONTS: readonly FontDef[] = [
  { id: 'archivo', family: 'Archivo', file: 'archivo-var-latin.woff2', weight: '100 900' },
  { id: 'inter', family: 'Inter', file: 'inter-var-latin.woff2', weight: '100 900' },
  { id: 'anton', family: 'Anton', file: 'anton-latin.woff2', weight: '400', singleWeight: true },
  { id: 'bebas', family: 'Bebas Neue', file: 'bebas-neue-latin.woff2', weight: '400', singleWeight: true },
  { id: 'playfair', family: 'Playfair Display', file: 'playfair-display-var-latin.woff2', weight: '400 900' },
  { id: 'caveat', family: 'Caveat', file: 'caveat-var-latin.woff2', weight: '400 700' },
];

const BY_ID = new Map(FONTS.map((f) => [f.id, f]));

/** The definition for an id, falling back to the default on an unknown one. */
export function fontDef(id: FontId | undefined): FontDef {
  return BY_ID.get(id ?? DEFAULT_FONT_ID) ?? BY_ID.get(DEFAULT_FONT_ID)!;
}

/** Family stack for `ctx.font`: a system fallback covers the face while it loads. */
export function fontStack(id: FontId | undefined): string {
  return `"${fontDef(id).family}", system-ui, -apple-system, sans-serif`;
}

const pending = new Map<FontId, Promise<void>>();
const listeners = new Set<() => void>();

/**
 * Notified when a face finishes loading. A paused preview draws once and stops,
 * so it needs the nudge to repaint with the real glyphs instead of leaving the
 * fallback on screen until the next edit.
 */
export function onFontLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The FontFaceSet of the current global: `document.fonts`, or `self.fonts` in a worker. */
function fontSet(): FontFaceSet | undefined {
  return (
    (globalThis as { fonts?: FontFaceSet }).fonts ??
    (typeof document !== 'undefined' ? document.fonts : undefined)
  );
}

/**
 * Register a face in the current global, once. Resolves when it is usable -
 * failures resolve too, since a missing face only means the fallback stays.
 */
export function loadFont(id: FontId | undefined): Promise<void> {
  const def = fontDef(id);
  const existing = pending.get(def.id);
  if (existing) return existing;

  const set = fontSet();
  if (typeof FontFace === 'undefined' || !set) return Promise.resolve();

  const url = `${import.meta.env.BASE_URL}fonts/${def.file}`;
  const promise = new FontFace(def.family, `url("${url}") format("woff2")`, { weight: def.weight })
    .load()
    .then((face) => {
      set.add(face);
      for (const fn of listeners) fn();
    })
    .catch(() => {
      // Non-fatal: `fontStack()` already names a system fallback.
    });
  pending.set(def.id, promise);
  return promise;
}

/** Register every face in a set of ids (duplicates and undefined are fine). */
export function loadFonts(ids: Iterable<FontId | undefined>): Promise<void> {
  return Promise.all([...ids].map(loadFont)).then(() => undefined);
}
