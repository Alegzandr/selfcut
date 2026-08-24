import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';

/**
 * i18n setup. English is the pivot locale: its dictionary is the source of
 * truth for the key set (see `I18nKeys` below - a missing or unknown key is a
 * TypeScript error, not a runtime "topbar.export" leaking into the UI).
 *
 * English is bundled; the other seven are fetched on demand. Eight dictionaries of
 * 729 keys is a real fraction of the editor's initial download, and seven eighths
 * of it is always for languages this visitor does not read. `ensureLocale` is
 * awaited before the React root mounts, so nothing flashes untranslated - the
 * cost is one small parallel request, not a repaint.
 *
 * Outside React (exporter, presets, probe, ...) import the default export and
 * call `i18n.t(...)` directly - see `t()` re-exported below.
 */

export const LOCALES = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  'pt-BR': 'Português (BR)',
  ja: '日本語',
  'zh-CN': '简体中文',
  ko: '한국어',
} as const;

export type Locale = keyof typeof LOCALES;

export const STORAGE_KEY = 'selfcut.lang';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    // Adding a bundle after init must re-render what is already mounted, which
    // is exactly what a language switch does once the app is running.
    react: { bindI18nStore: 'added' },
    supportedLngs: Object.keys(LOCALES),
    fallbackLng: {
      // A browser reporting plain "pt" gets the Brazilian dictionary rather
      // than falling straight through to English.
      pt: ['pt-BR', 'en'],
      // Likewise for a plain "zh": Simplified is the only Chinese we ship.
      zh: ['zh-CN', 'en'],
      default: ['en'],
    },
    // "fr-CA" / "de-AT" resolve to "fr" / "de" instead of the fallback.
    nonExplicitSupportedLngs: true,
    // Keys are flat, dots and colons included: "inspector.bold" (Bold) and
    // "inspector.bold.short" (B) must coexist, which nesting cannot express.
    keySeparator: false,
    nsSeparator: false,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: {
      // React already escapes everything it renders.
      escapeValue: false,
    },
  });

/**
 * The dictionaries that are not bundled. Static `import()` calls, not a
 * template literal: the bundler has to see each path to emit a chunk for it.
 */
const LOADERS: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  fr: () => import('./locales/fr.json'),
  es: () => import('./locales/es.json'),
  de: () => import('./locales/de.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  ja: () => import('./locales/ja.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
  ko: () => import('./locales/ko.json'),
};

/**
 * Make sure a language's dictionary is loaded. Resolves immediately for English
 * and for anything already fetched; a failed fetch resolves too, leaving
 * i18next on its English fallback rather than blocking the editor from booting
 * over a missing translation file.
 */
export async function ensureLocale(lng: string | undefined): Promise<void> {
  const base = lng && lng in LOADERS ? lng : (lng ?? '').split('-')[0];
  const load = base ? LOADERS[base] : undefined;
  if (!load || i18n.hasResourceBundle(base!, 'translation')) return;
  try {
    const mod = await load();
    i18n.addResourceBundle(base!, 'translation', mod.default, true, true);
  } catch {
    /* stay on the English fallback */
  }
}

// A language picked in Preferences (or restored from localStorage on a later
// visit) has to bring its dictionary with it.
i18n.on('languageChanged', (lng) => {
  void ensureLocale(lng);
});

/** Keep the document in sync so screen readers and hyphenation follow the UI. */
function syncDocumentLang(lng: string): void {
  document.documentElement.lang = lng;
}
syncDocumentLang(i18n.resolvedLanguage ?? 'en');
i18n.on('languageChanged', syncDocumentLang);

/** Imperative translator, for the modules that have no access to hooks. */
export const t = i18n.t.bind(i18n);

export default i18n;
