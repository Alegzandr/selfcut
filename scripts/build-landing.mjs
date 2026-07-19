// Generates the static landing pages from landing/template.html and
// landing/locales/*.json: the French page at the repo root (canonical) and one
// subdirectory per other language (en/, es/, de/, pt-BR/). Vite then picks
// them up as MPA inputs. Run via `npm run landing` (also part of dev/build).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://selfcut.alegzandr.com';

// `path` is relative to the site root; fr is the canonical root page.
// Display order matches the app's language menu (src/i18n/index.ts LOCALES).
const LANGS = [
  { code: 'en', name: 'English', ogLocale: 'en_US', path: 'en/' },
  { code: 'fr', name: 'Français', ogLocale: 'fr_FR', path: '' },
  { code: 'es', name: 'Español', ogLocale: 'es_ES', path: 'es/' },
  { code: 'de', name: 'Deutsch', ogLocale: 'de_DE', path: 'de/' },
  { code: 'pt-BR', name: 'Português (BR)', ogLocale: 'pt_BR', path: 'pt-BR/' },
];

// English serves visitors whose language matches none of the five.
const X_DEFAULT = LANGS.find((l) => l.code === 'en');

const template = readFileSync(join(root, 'landing', 'template.html'), 'utf8');

const alternates = [
  ...LANGS.map(
    (l) => `    <link rel="alternate" hreflang="${l.code}" href="${ORIGIN}/${l.path}" />`,
  ),
  `    <link rel="alternate" hreflang="x-default" href="${ORIGIN}/${X_DEFAULT.path}" />`,
].join('\n');

for (const lang of LANGS) {
  const strings = JSON.parse(
    readFileSync(join(root, 'landing', 'locales', `${lang.code}.json`), 'utf8'),
  );
  const url = `${ORIGIN}/${lang.path}`;

  const jsonldApp = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SelfCut',
    url: `${ORIGIN}/app/`,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    browserRequirements: strings['schema.browserReq'],
    inLanguage: LANGS.map((l) => l.code),
    description: strings['schema.description'],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  };

  const jsonldFaq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [1, 2, 3, 4, 5].map((n) => ({
      '@type': 'Question',
      name: strings[`faq.q${n}`],
      acceptedAnswer: { '@type': 'Answer', text: strings[`faq.a${n}`] },
    })),
  };

  const computed = {
    url,
    home: `/${lang.path}`,
    currentLang: lang.name,
    htmlAttrs:
      lang.path === '' ? `lang="${lang.code}" data-default` : `lang="${lang.code}"`,
    ogLocale: lang.ogLocale,
    ogAlternates: LANGS.filter((l) => l !== lang)
      .map((l) => `    <meta property="og:locale:alternate" content="${l.ogLocale}" />`)
      .join('\n'),
    alternates,
    jsonldApp: JSON.stringify(jsonldApp),
    jsonldFaq: JSON.stringify(jsonldFaq),
    langNav: LANGS.map((l) => {
      const current = l === lang ? ' aria-current="page"' : '';
      return `            <a href="/${l.path}" lang="${l.code}" hreflang="${l.code}" data-lang="${l.code}"${current}>${l.name}</a>`;
    }).join('\n'),
  };

  const html = template.replace(/\{\{([\w.@-]+)\}\}/g, (_, key) => {
    const value = computed[key] ?? strings[key];
    if (value === undefined) {
      throw new Error(`Missing key "${key}" for locale "${lang.code}"`);
    }
    return value;
  });

  const outDir = join(root, lang.path);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  console.log(`landing: ${lang.code} -> ${lang.path || '(root)'}index.html`);
}
