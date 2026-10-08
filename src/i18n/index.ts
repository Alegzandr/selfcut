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

const initialized = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    // Adding a bundle after init must re-render what is already mounted, which
    // is exactly what a language switch does once the app is running.
    react: { bindI18nStore: 'added' },
    // With `nonExplicitSupportedLngs`, i18next checks a tag by its base
    // language: "pt-BR" passes only if "pt" is listed. Without the two bases,
    // Portuguese and Chinese were refused even when picked in Preferences.
    supportedLngs: [...Object.keys(LOCALES), 'pt', 'zh'],
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
      // Only an explicit choice is remembered (see `setLocale`). Caching the
      // detected language would pin a first visit's English fallback ahead of
      // the browser's list, and stop following a browser language change.
      caches: [],
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
 * The dictionary a language tag is served by: itself, its base language
 * ("fr-CA" by "fr"), or the regional variant we ship for it ("pt" by "pt-BR").
 */
function loaderKey(lng: string | undefined): string | undefined {
  if (!lng) return undefined;
  if (lng in LOADERS) return lng;
  const base = lng.split('-')[0]!;
  if (base in LOADERS) return base;
  return Object.keys(LOADERS).find((k) => k.split('-')[0] === base);
}

/**
 * Make sure a language's dictionary is loaded. Resolves immediately for English
 * and for anything already fetched; a failed fetch resolves too, leaving
 * i18next on its English fallback rather than blocking the editor from booting
 * over a missing translation file. Returns whether a dictionary was added.
 */
export async function ensureLocale(lng: string | undefined): Promise<boolean> {
  const key = loaderKey(lng);
  if (!key || i18n.hasResourceBundle(key, 'translation')) return false;
  try {
    const mod = await LOADERS[key]!();
    i18n.addResourceBundle(key, 'translation', mod.default, true, true);
    return true;
  } catch {
    /* stay on the English fallback */
    return false;
  }
}

/**
 * Switch language, dictionary first. i18next resolves `resolvedLanguage`
 * against the bundles present at switch time, so switching before the fetch
 * lands leaves it on English: the Preferences picker then shows English while
 * the UI reads in the chosen language.
 */
export async function setLocale(lng: string): Promise<void> {
  await ensureLocale(lng);
  await i18n.changeLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* private mode / no storage - the choice just will not persist */
  }
}

/**
 * Load the detected language before the first render. Awaits init so the
 * detector has run (`resolvedLanguage` is still "en" then, because only the
 * English bundle exists), then switches again once the dictionary is in, so
 * `resolvedLanguage` and the document language follow.
 */
export async function loadInitialLocale(): Promise<void> {
  await initialized.catch(() => undefined);
  // The detector's own ranking (stored choice, then the browser's list), read
  // again here: i18next drops a tag it cannot match exactly, so a browser
  // reporting plain "pt" or "zh" would otherwise land on English.
  const detected = i18n.services.languageDetector?.detect();
  const candidates = (Array.isArray(detected) ? detected : [detected ?? i18n.language]).filter(Boolean) as string[];
  for (const lng of candidates) {
    if (lng.split('-')[0] === 'en') return;
    const key = loaderKey(lng);
    if (!key) continue;
    await ensureLocale(key);
    if (i18n.hasResourceBundle(key, 'translation')) await i18n.changeLanguage(key);
    return;
  }
}

// A language changed by anything other than `setLocale` (the detector, a
// direct `changeLanguage`) still has to bring its dictionary with it, and
// then re-resolve so `resolvedLanguage` stops reporting the fallback.
i18n.on('languageChanged', (lng) => {
  void ensureLocale(lng).then((added) => {
    if (added && i18n.language === lng) void i18n.changeLanguage(lng);
  });
});

/** Keep the document in sync so screen readers and hyphenation follow the UI. */
function syncDocumentLang(lng: string): void {
  document.documentElement.lang = lng;
}
syncDocumentLang(i18n.resolvedLanguage ?? 'en');
i18n.on('languageChanged', () => syncDocumentLang(i18n.resolvedLanguage ?? 'en'));

/** Imperative translator, for the modules that have no access to hooks. */
export const t = i18n.t.bind(i18n);

export default i18n;
