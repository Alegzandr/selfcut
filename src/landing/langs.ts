/**
 * The languages the landing ships in, and the URLs derived from them.
 *
 * Deliberately not read from `src/i18n/index.ts`: that module boots i18next as
 * a side effect of being imported, which is not something a page render at
 * build time should do. The display order mirrors the app's language menu
 * (LOCALES there) - keep the two lists in sync when a language is added.
 */

export const ORIGIN = 'https://selfcut.alegzandr.com';

export interface Lang {
  code: string;
  /** Endonym, as shown in the language selector. */
  name: string;
  ogLocale: string;
  /** Path relative to the site root. French is the canonical root page. */
  path: string;
}

export const LANGS = [
  { code: 'en', name: 'English', ogLocale: 'en_US', path: 'en/' },
  { code: 'fr', name: 'Français', ogLocale: 'fr_FR', path: '' },
  { code: 'es', name: 'Español', ogLocale: 'es_ES', path: 'es/' },
  { code: 'de', name: 'Deutsch', ogLocale: 'de_DE', path: 'de/' },
  { code: 'pt-BR', name: 'Português (BR)', ogLocale: 'pt_BR', path: 'pt-BR/' },
] as const satisfies readonly Lang[];

export type LangCode = (typeof LANGS)[number]['code'];

export function langByCode(code: LangCode): (typeof LANGS)[number] {
  const lang = LANGS.find((l) => l.code === code);
  if (!lang) throw new Error(`Unknown landing language "${code}"`);
  return lang;
}

/**
 * The root page: the one a first-time visitor is redirected from, and the one
 * that serves the French content to the crawlers that skip that redirect.
 */
export const DEFAULT_LANG = langByCode('fr');

/** Absolute URL of a language's landing page. */
export const urlOf = (lang: Lang): string => `${ORIGIN}/${lang.path}`;

/**
 * The hreflang set shared by every page's <head> and by every sitemap entry:
 * both want the same complete list, self-reference included.
 *
 * x-default points at the root page because that is the one that redirects a
 * visitor to their language (see `lang.ts`), which is what the attribute is
 * for.
 */
export const ALTERNATES: readonly { hreflang: string; href: string }[] = [
  ...LANGS.map((lang) => ({ hreflang: lang.code, href: urlOf(lang) })),
  { hreflang: 'x-default', href: urlOf(DEFAULT_LANG) },
];
